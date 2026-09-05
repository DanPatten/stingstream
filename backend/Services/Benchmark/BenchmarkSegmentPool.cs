using System.Collections.Concurrent;

namespace NzbWebDAV.Services.Benchmark;

/// <summary>
/// Thread-safe round-robin view over the benchmark corpus for one run. Skips
/// message-ids observed to be dead (430) so wall-clock isn't wasted re-asking
/// for them, and tracks whether the run wrapped around the pool (repeat
/// fetches hit provider caches and inflate speeds).
/// </summary>
internal sealed class BenchmarkSegmentPool(IReadOnlyList<string> ids)
{
    private readonly ConcurrentDictionary<string, byte> _dead = new();
    private long _cursor = -1;
    private long _taken;

    public int Count => ids.Count;
    public int DeadCount => _dead.Count;
    public bool WrappedAround => Interlocked.Read(ref _taken) > ids.Count;

    public void MarkDead(string id) => _dead.TryAdd(id, 0);

    public string Next()
    {
        Interlocked.Increment(ref _taken);
        var probes = Math.Min(ids.Count, 64);
        for (var attempt = 0; attempt < probes; attempt++)
        {
            var i = Interlocked.Increment(ref _cursor);
            var id = ids[(int)((i % ids.Count + ids.Count) % ids.Count)];
            if (!_dead.ContainsKey(id)) return id;
        }

        // Everything nearby looks dead — hand one back anyway; the worker just
        // records another miss and the result carries a corpus warning.
        var j = Interlocked.Increment(ref _cursor);
        return ids[(int)((j % ids.Count + ids.Count) % ids.Count)];
    }

    public List<string> NextBatch(int count)
    {
        var batch = new List<string>(count);
        for (var i = 0; i < count; i++) batch.Add(Next());
        return batch;
    }
}
