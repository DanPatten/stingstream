using NzbWebDAV.Services;

namespace NzbWebDAV.Tests;

public class ProviderUsageTrackerTests
{
    [Fact]
    public async Task RecordSuccess_AttributesProviderAndKeepsReadActive()
    {
        var registry = new ActiveReadRegistry();
        var sessionId = registry.GetOrCreate("/view/item", "client", "item.mkv", 1024);
        var before = registry.Snapshot().Single().LastActivityAt;
        var tracker = new ProviderUsageTracker(registry);

        await Task.Delay(5);
        using (tracker.BeginScope(sessionId))
            tracker.RecordSuccess("news.example");

        Assert.Equal(1, tracker.Snapshot(sessionId)["news.example"]);
        Assert.True(registry.Snapshot().Single().LastActivityAt > before);
    }
}
