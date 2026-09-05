using Microsoft.AspNetCore.Mvc;
using NzbWebDAV.Config;
using NzbWebDAV.Database;
using NzbWebDAV.Tasks;
using NzbWebDAV.Websocket;

namespace NzbWebDAV.Api.Controllers.RecreateStrmFiles;

[ApiController]
[Route("api/recreate-strm-files")]
public class RecreateStrmFilesController(
    ConfigManager configManager,
    DavDatabaseClient dbClient,
    WebsocketManager websocketManager
) : BaseApiController
{
    protected override async Task<IActionResult> HandleRequest()
    {
        var rewriteAll = string.Equals(
            HttpContext.Request.Query["rewriteAll"].FirstOrDefault(),
            "true",
            StringComparison.OrdinalIgnoreCase);

        var task = new RecreateStrmFilesTask(configManager, dbClient, websocketManager, rewriteAll);
        var executed = await task.Execute().ConfigureAwait(false);
        if (!executed)
            return Conflict(new { error = "Recreate STRM Files task is already running." });
        return Ok(executed);
    }
}
