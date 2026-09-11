using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.Configuration;

/// <summary>
/// Keeps the one name this server has in step everywhere it is held.
/// </summary>
/// <remarks>
/// <para>
/// <b>A server has one name.</b> Jellyfin holds it in its own configuration, which is what the
/// sign-in card and the invite landing page read; <c>runtime.json</c> holds it so it survives a
/// restart; and the mesh announces it, which is what a linked server sees in its list and what a
/// link gets named after. There used to be a fourth, <c>config.toml</c>'s <c>node_name</c>, and
/// the word <em>node</em> went with it: it is the same name and calling it two things is what let
/// the two drift.
/// </para>
/// <para>
/// <b>Renaming happened in one of them and stayed there.</b> The Settings screen writes Jellyfin's
/// configuration directly, so nothing here was told: <c>runtime.json</c> kept the name chosen at
/// first run and the mesh went on announcing the name it booted with. Two servers renamed after
/// setup therefore introduced themselves to each other by the string in the config template they
/// were built from, and the link each created was named after it. Found on a pair of freshly
/// installed nodes that both insisted they were called <c>ui-loop</c>.
/// </para>
/// <para>
/// So the rename is observed rather than routed: <see cref="IConfigurationManager.ConfigurationUpdated"/>
/// fires for a change made from anywhere, this app or the official Jellyfin client, and the other
/// two are brought into line. Writing to <c>runtime.json</c> is what survives the restart; telling
/// the mesh is what means nobody has to wait for one.
/// </para>
/// <para>
/// The mesh may be down, and that is not a failure worth reporting to anybody: the name is on disk
/// by then, so the next start announces it regardless. Logged and dropped.
/// </para>
/// </remarks>
public sealed class ServerNameWatcher : IHostedService, IDisposable
{
    private readonly IServerApplicationHost _host;
    private readonly IConfigurationManager _configuration;
    private readonly INodeRuntimeProvider _runtime;
    private readonly IMeshClient _mesh;
    private readonly ILogger<ServerNameWatcher> _logger;

    /// <summary>How many times to offer the name to a mesh that has not finished starting.</summary>
    private const int StartupAttempts = 20;

    /// <summary>How long to wait between those.</summary>
    private static readonly TimeSpan StartupRetryDelay = TimeSpan.FromSeconds(6);

    /// <summary>The name as this watcher last saw it, so an unrelated settings save does nothing.</summary>
    private string _lastSeen = string.Empty;

    public ServerNameWatcher(
        IServerApplicationHost host,
        IConfigurationManager configuration,
        INodeRuntimeProvider runtime,
        IMeshClient mesh,
        ILogger<ServerNameWatcher> logger)
    {
        _host = host;
        _configuration = configuration;
        _runtime = runtime;
        _mesh = mesh;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _lastSeen = _host.FriendlyName ?? string.Empty;
        _configuration.ConfigurationUpdated += OnConfigurationUpdated;

        // And once now, because reacting to changes is only half of it. The mesh boots from
        // `mesh.toml`, which carries whatever name the node was built with; the server's real name
        // lives in Jellyfin's configuration. Without this they disagree from startup until somebody
        // happens to rename something -- which is exactly how two servers called "Fresh A" and
        // "Fresh B" both introduced themselves to each other as "ui-loop".
        _ = Task.Run(() => ReconcileAtStartAsync(_lastSeen), CancellationToken.None);
        return Task.CompletedTask;
    }

    /// <summary>Tell the mesh this server's name once it is listening.</summary>
    /// <remarks>
    /// The mesh child is started beside this one and is usually a few seconds behind it, so a
    /// single attempt at startup would miss. Bounded rather than indefinite: if it has not come up
    /// in this long the name is the least of what is wrong, and the next start tries again.
    /// </remarks>
    private async Task ReconcileAtStartAsync(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return;
        }

        for (var attempt = 0; attempt < StartupAttempts; attempt++)
        {
            try
            {
                await _mesh.SetServerNameAsync(name, CancellationToken.None).ConfigureAwait(false);
                return;
            }
            catch (Exception ex) when (attempt < StartupAttempts - 1)
            {
                _logger.LogDebug(ex, "The mesh is not ready for this server's name yet");
                await Task.Delay(StartupRetryDelay).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Could not tell the mesh this server's name. Its links show whatever it "
                    + "booted with until it is renamed or restarted.");
            }
        }
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _configuration.ConfigurationUpdated -= OnConfigurationUpdated;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public void Dispose() => _configuration.ConfigurationUpdated -= OnConfigurationUpdated;

    private void OnConfigurationUpdated(object? sender, EventArgs e)
    {
        // Every configuration save comes through here, and almost none of them is a rename.
        var name = _host.FriendlyName?.Trim();
        if (string.IsNullOrEmpty(name) || string.Equals(name, _lastSeen, StringComparison.Ordinal))
        {
            return;
        }

        _lastSeen = name;
        _logger.LogInformation("This server was renamed to {ServerName}", name);

        // On disk first. If this process dies in the next line, the name is still the new one when
        // it comes back; the other order would lose it.
        try
        {
            _runtime.SetServerName(name);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not record the new server name for the next start");
        }

        // Then the running mesh, so the servers this one is linked with stop showing the old name.
        // Fire and forget: the event is raised on whatever thread saved the configuration, and a
        // rename must not be able to block a settings save.
        _ = Task.Run(async () =>
        {
            try
            {
                await _mesh.SetServerNameAsync(name, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Renamed this server, but could not tell the mesh. Its links learn the new "
                    + "name when it next starts.");
            }
        });
    }
}
