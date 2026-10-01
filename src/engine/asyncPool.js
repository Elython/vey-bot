async function mapWithConcurrency(items, concurrency, worker) {
  const values = Array.from(items || []);
  if (values.length === 0) return [];
  const limit = Math.max(1, Math.min(values.length, Math.trunc(Number(concurrency) || 1)));
  const results = new Array(values.length);
  let cursor = 0;

  const run = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

module.exports = { mapWithConcurrency };
