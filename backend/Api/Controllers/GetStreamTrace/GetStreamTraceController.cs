using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NzbWebDAV.Services.StreamTrace;

namespace NzbWebDAV.Api.Controllers.GetStreamTrace;

[ApiController]
[Route("api/get-stream-trace")]
public class GetStreamTraceController(StreamTraceBuffer buffer) : BaseApiController
{
    protected override Task<IActionResult> HandleRequest()
    {
        var raw = HttpContext.Request.Query["sessionId"].ToString();
        if (string.IsNullOrWhiteSpace(raw) || !Guid.TryParse(raw, out var sessionId))
            throw new BadHttpRequestException("sessionId query parameter is required (GUID).");

        var events = buffer.GetSessionEvents(sessionId);
        var summary = buffer.ListSessions(500).FirstOrDefault(s => s.SessionId == sessionId);

        return Task.FromResult<IActionResult>(Ok(new GetStreamTraceResponse
        {
            Status = true,
            SessionId = sessionId,
            Path = summary?.Path,
            FirstAt = summary?.FirstAt,
            LastAt = summary?.LastAt,
            EventCount = events.Count,
            Events = events,
        }));
    }
}
