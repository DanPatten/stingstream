namespace NzbWebDAV.Api.Controllers.TriggerHealthCheck;

public class TriggerHealthCheckResponse : BaseApiResponse
{
    public int QueuedCount { get; init; }
    public bool AlreadyRunning { get; init; }
}
