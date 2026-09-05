using System.Text.Json.Serialization;
using NzbWebDAV.Services.StreamTrace;

namespace NzbWebDAV.Api.Controllers.GetStreamTrace;

public class GetStreamTraceResponse : BaseApiResponse
{
    [JsonPropertyName("sessionId")] public required Guid SessionId { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
    [JsonPropertyName("firstAt")] public long? FirstAt { get; init; }
    [JsonPropertyName("lastAt")] public long? LastAt { get; init; }
    [JsonPropertyName("eventCount")] public required int EventCount { get; init; }
    [JsonPropertyName("events")] public required IReadOnlyList<StreamTraceEvent> Events { get; init; }
}
