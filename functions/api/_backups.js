// functions/api/_backups.js — shared helper, NOT a route.
//
// Daily snapshots of each client's pos-sync state, scoped per client the same
// way everything else in this project is (see _license.js). Backs the
// Settings -> Backups panel in each product's front-end (backups.js is the
// actual route) and the automatic snapshot pos-sync.js takes on every write.
//
// One snapshot per calendar day per client — every device pushes roughly
// every 7 seconds while the app is open, so without the once-per-day guard
// the "backup" would be rewritten dozens of times a day and only ever hold
// a few seconds of history, defeating the point.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

const BACKUP_PREFIX = 'pos-data:backup:';
const BACKUP_RETENTION_DAYS = 30;

function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}
function backupPrefix(clientId) {
  return `${BACKUP_PREFIX}${clientId}:`;
}
function lastBackupDateKey(clientId) {
  return `${BACKUP_PREFIX}${clientId}:last-date`;
}

function todayDateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, server clock (UTC)
}

// Call this from pos-sync.js right before it overwrites a client's live
// state — snapshots whatever was CURRENTLY there (i.e. about to be
// overwritten) into a dated backup key, but only once per day per client.
// A backup failure here must never block the actual sync write that
// triggered it, so every KV call is wrapped.
export async function maybeSnapshotBackup(env, clientId) {
  try {
    const today = todayDateStr();
    const lastKey = lastBackupDateKey(clientId);
    const lastBackupDate = await env.mydukapos_kv.get(lastKey);
    if (lastBackupDate === today) return; // already snapshotted today

    const currentRaw = await env.mydukapos_kv.get(stateKey(clientId));
    if (currentRaw) {
      await env.mydukapos_kv.put(backupPrefix(clientId) + today, currentRaw);
    }
    await env.mydukapos_kv.put(lastKey, today);
    await pruneOldBackups(env, clientId, today);
  } catch (e) {
    // Non-fatal — see comment above.
  }
}

async function pruneOldBackups(env, clientId, todayStr) {
  const cutoff = new Date(todayStr);
  cutoff.setUTCDate(cutoff.getUTCDate() - BACKUP_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const cutoffMs = cutoff.getTime();

  const prefix = backupPrefix(clientId);
  const list = await env.mydukapos_kv.list({ prefix });
  for (const item of list.keys) {
    const suffix = item.name.slice(prefix.length);

    if (suffix === 'last-date') continue; // the marker key itself, never a real backup

    if (/^\d{4}-\d{2}-\d{2}$/.test(suffix)) {
      if (suffix < cutoffStr) await env.mydukapos_kv.delete(item.name);
      continue;
    }

    // Pre-restore safety copies (see backups.js restore handler) are named
    // 'pre-restore-<ms timestamp>', not a plain date — prune those past the
    // same retention window too, or a restore-happy admin accumulates them
    // forever.
    const preRestoreMatch = suffix.match(/^pre-restore-(\d+)$/);
    if (preRestoreMatch && Number(preRestoreMatch[1]) < cutoffMs) {
      await env.mydukapos_kv.delete(item.name);
    }
  }
}

export async function listBackupDates(env, clientId) {
  const prefix = backupPrefix(clientId);
  const list = await env.mydukapos_kv.list({ prefix });
  return list.keys
    .map((k) => k.name.slice(prefix.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) // excludes 'last-date' and pre-restore-* markers
    .sort()
    .reverse();
}

// Returns { restored: true } or { error: '...' }. Keeps a pre-restore safety
// copy of whatever was live immediately before, so a wrong-date restore has
// a way back too.
export async function restoreBackup(env, clientId, date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'Invalid or missing date.' };
  }

  const raw = await env.mydukapos_kv.get(backupPrefix(clientId) + date);
  if (!raw) return { error: `No backup found for ${date}.`, status: 404 };

  try {
    const preRestoreRaw = await env.mydukapos_kv.get(stateKey(clientId));
    if (preRestoreRaw) {
      await env.mydukapos_kv.put(backupPrefix(clientId) + 'pre-restore-' + Date.now(), preRestoreRaw);
    }
  } catch (e) {
    // Non-fatal — proceed with the restore even if this safety copy fails.
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return { error: 'That backup is corrupted and cannot be restored.', status: 500 };
  }
  // Restamp updatedAt to now so every device's next pull recognizes this as
  // newer than whatever they currently have and actually pulls it in.
  record.updatedAt = Date.now();

  await env.mydukapos_kv.put(stateKey(clientId), JSON.stringify(record));
  // Also mark today as already "snapshotted" — prevents the very next sync
  // push from immediately re-snapshotting this restore over today's slot.
  await env.mydukapos_kv.put(lastBackupDateKey(clientId), todayDateStr());

  return { restored: true, date };
}
