namespace MediaLauncher.Agent.Core;

public sealed class BoundedRequestCache<T>(int capacity, TimeSpan retention)
{
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public bool TryGet(string requestId, DateTimeOffset now, out T? value)
    {
        Prune(now);
        if (_entries.TryGetValue(requestId, out var entry))
        {
            value = entry.Value;
            return true;
        }
        value = default;
        return false;
    }

    public void Set(string requestId, T value, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(requestId)) return;
        Prune(now);
        if (_entries.Count >= capacity && !_entries.ContainsKey(requestId))
        {
            var oldest = _entries.MinBy(item => item.Value.CreatedAt).Key;
            _entries.Remove(oldest);
        }
        _entries[requestId] = new Entry(value, now);
    }

    public void Prune(DateTimeOffset now)
    {
        var cutoff = now - retention;
        foreach (var key in _entries
            .Where(item => item.Value.CreatedAt < cutoff)
            .Select(item => item.Key)
            .ToArray())
        {
            _entries.Remove(key);
        }
    }

    public void Clear() => _entries.Clear();

    private sealed record Entry(T Value, DateTimeOffset CreatedAt);
}
