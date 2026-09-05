using Microsoft.AspNetCore.Mvc;
using NzbWebDAV.Config;
using NzbWebDAV.Tasks;
using NzbWebDAV.Websocket;

namespace NzbWebDAV.Api.Controllers.RenameWindowsInvalidDavPaths;

[ApiController]
[Route("api/rename-windows-invalid-dav-paths")]
public class RenameWindowsInvalidDavPathsController(
    ConfigManager configManager,
    WebsocketManager websocketManager
) : BaseApiController
{
    protected override async Task<IActionResult> HandleRequest()
    {
        var task = new RenameWindowsInvalidDavPathsTask(configManager, websocketManager, isDryRun: false);
        var executed = await task.Execute().ConfigureAwait(false);
        if (!executed)
            return Conflict(new { error = "Rename Windows-Invalid Dav Paths task is already running." });
        return Ok(executed);
    }
}
