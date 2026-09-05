using Microsoft.AspNetCore.Mvc;
using NzbWebDAV.Tasks;

namespace NzbWebDAV.Api.Controllers.RenameWindowsInvalidDavPaths;

[ApiController]
[Route("api/rename-windows-invalid-dav-paths/audit")]
public class RenameWindowsInvalidDavPathsAuditController : BaseApiController
{
    protected override Task<IActionResult> HandleRequest()
    {
        var report = RenameWindowsInvalidDavPathsTask.GetAuditReport();
        return Task.FromResult<IActionResult>(Ok(report));
    }
}
