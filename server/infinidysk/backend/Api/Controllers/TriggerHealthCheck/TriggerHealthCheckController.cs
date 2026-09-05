using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NzbWebDAV.Config;
using NzbWebDAV.Config.Scheduling;
using NzbWebDAV.Database;
using NzbWebDAV.Services;

namespace NzbWebDAV.Api.Controllers.TriggerHealthCheck;

[ApiController]
[Route("api/trigger-health-check")]
public class TriggerHealthCheckController(
    DavDatabaseClient dbClient,
    ConfigManager configManager,
    HealthWorkSchedulePolicy healthWorkSchedule
) : BaseApiController
{
    protected override async Task<IActionResult> HandleRequest()
    {
        if (!HttpMethods.IsPost(HttpContext.Request.Method))
        {
            return StatusCode(
                StatusCodes.Status405MethodNotAllowed,
                new BaseApiResponse { Status = false, Error = "POST required" });
        }

        if (!configManager.IsRepairJobEnabled())
        {
            return StatusCode(
                StatusCodes.Status409Conflict,
                new BaseApiResponse
                {
                    Status = false,
                    Error = configManager.GetRepairDisabledReason() ?? "Background repairs are disabled.",
                });
        }

        var alreadyRunning = healthWorkSchedule.BeginManualRun();
        var queuedCount = await HealthCheckQueueMutations
            .MakeDueAsync(dbClient.Ctx, HttpContext.RequestAborted)
            .ConfigureAwait(false);

        return StatusCode(
            StatusCodes.Status202Accepted,
            new TriggerHealthCheckResponse
            {
                Status = true,
                QueuedCount = queuedCount,
                AlreadyRunning = alreadyRunning,
            });
    }
}
