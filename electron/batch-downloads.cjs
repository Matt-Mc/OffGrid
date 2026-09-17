'use strict';
function batchResult(results) {
  const counts = { added: 0, alreadyQueued: 0, alreadySaved: 0, rejected: 0 };
  for (const result of results) if (Object.hasOwn(counts, result.outcome)) counts[result.outcome]++;
  return { results, counts };
}
function validateBatch(items) {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw new Error('Select between 1 and 500 items.');
}
function projectQueue(jobs, storage) {
  let completed = 0, peakAdditional = 0, unknownCount = 0, knownBytes = 0;
  for (const job of jobs.filter(job => ['queued', 'paused', 'preparing', 'downloading', 'processing', 'waiting-network', 'waiting-storage'].includes(job.status))) {
    const expected = job.expectedBytes;
    if (!Number.isFinite(expected) || expected <= 0) { unknownCount++; continue; }
    const multiplier = ['plex', 'jellyfin'].includes(job.provider) ? job.copyQuality === '720p' ? 2 : 1 : 3;
    const retained = Math.max(0, job.retainedBytes || 0);
    knownBytes += expected;
    peakAdditional = Math.max(peakAdditional, completed + Math.max(0, expected * multiplier + (job.copyQuality === '720p' ? 32_000_000 : 16_000_000) - retained));
    completed += Math.max(0, expected - retained);
  }
  return { knownBytes, unknownCount, additionalPeakBytes: peakAdditional, fits: unknownCount ? null :
    storage.freeBytes !== null && storage.freeBytes >= storage.diskReserveBytes + peakAdditional &&
    (storage.maxLibraryBytes === null || storage.savedBytes + storage.temporaryBytes + peakAdditional <= storage.maxLibraryBytes) };
}
module.exports = { batchResult, validateBatch, projectQueue };
