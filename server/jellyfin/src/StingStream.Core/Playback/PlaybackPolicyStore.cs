using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;

namespace StingStream.Core.Playback;

/// <summary>The wire spellings of <see cref="PlaybackPolicy"/>, shared with the mesh's Rust enum.</summary>
public static class PolicyNames
{
    /// <summary>Speed first, on the wire.</summary>
    public const string SpeedFirst = "speed_first";

    /// <summary>Quality first, on the wire.</summary>
    public const string QualityFirst = "quality_first";

    /// <summary>The wire form of a policy.</summary>
    /// <param name="policy">The policy.</param>
    /// <returns>The snake_case name serde and the mesh's query parameters use.</returns>
    public static string Wire(PlaybackPolicy policy)
        => policy == PlaybackPolicy.QualityFirst ? QualityFirst : SpeedFirst;

    /// <summary>Parse a policy, tolerating the spellings a hand-written request might carry.</summary>
    /// <param name="value">The text.</param>
    /// <returns>The policy, or null when the text names neither.</returns>
    public static PlaybackPolicy? Parse(string? value)
    {
        var normalised = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
        return normalised switch
        {
            "speed_first" or "speed" => PlaybackPolicy.SpeedFirst,
            "quality_first" or "quality" => PlaybackPolicy.QualityFirst,
            _ => null,
        };
    }
}

/// <summary>One user's playback preferences.</summary>
public sealed class UserPlaybackPolicy
{
    /// <summary>The Jellyfin user this belongs to, as a 32-character hex GUID.</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// Which of speed and quality to favour when several nodes hold the same title.
    /// </summary>
    /// <remarks>
    /// Serialized as the same snake_case names the mesh uses, so a value copied out of one API and
    /// into the other means the same thing.
    /// </remarks>
    public string Policy { get; set; } = PolicyNames.SpeedFirst;

    /// <summary>When it was last changed, RFC 3339.</summary>
    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>The parsed policy, falling back to the default for anything unrecognised.</summary>
    /// <returns>The policy.</returns>
    public PlaybackPolicy Parsed() => PolicyNames.Parse(Policy) ?? PlaybackPolicy.SpeedFirst;
}

/// <summary>
/// Where each user's Speed-first / Quality-first choice lives.
/// </summary>
/// <remarks>
/// <para>
/// A settings document in <c>core.db</c> rather than a Jellyfin <c>DisplayPreferences</c> row or a
/// column on the user: Jellyfin owns its own user schema and its migrations would then own this,
/// and display preferences are keyed per client which is the wrong granularity — a person's
/// tolerance for buffering does not change because they picked up a different device.
/// </para>
/// <para>
/// One document holding every user's choice, not one per user. The whole map is a few hundred bytes
/// and it is read on every <c>PlaybackInfo</c>, so a single row that the cache below can hold is
/// cheaper than a lookup per playback.
/// </para>
/// </remarks>
public sealed class PlaybackPolicyStore
{
    /// <summary>Key this document is stored under in <c>core.db</c>'s <c>settings</c> table.</summary>
    public const string StorageKey = "playback-policies";

    private readonly SettingsStore _settings;
    private readonly ILogger<PlaybackPolicyStore> _logger;
    private readonly object _gate = new();

    private Dictionary<string, UserPlaybackPolicy>? _cache;

    public PlaybackPolicyStore(SettingsStore settings, ILogger<PlaybackPolicyStore> logger)
    {
        _settings = settings;
        _logger = logger;
    }

    /// <summary>The policy for one user, or the default when they have never chosen one.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The policy.</returns>
    public UserPlaybackPolicy Get(Guid userId) => Get(Normalise(userId.ToString()));

    /// <summary>The policy for one user by id string.</summary>
    /// <param name="userId">The Jellyfin user id, in any GUID spelling.</param>
    /// <returns>The policy.</returns>
    public UserPlaybackPolicy Get(string? userId)
    {
        var key = Normalise(userId);
        if (key.Length == 0)
        {
            return new UserPlaybackPolicy { UserId = string.Empty };
        }

        var all = All();
        return all.TryGetValue(key, out var found)
            ? found
            : new UserPlaybackPolicy { UserId = key };
    }

    /// <summary>Every stored policy.</summary>
    /// <returns>The policies, keyed by normalised user id.</returns>
    public IReadOnlyDictionary<string, UserPlaybackPolicy> All()
    {
        lock (_gate)
        {
            if (_cache is not null)
            {
                return _cache;
            }

            try
            {
                var document = _settings.GetDocument<PolicyDocument>(StorageKey);
                _cache = new Dictionary<string, UserPlaybackPolicy>(StringComparer.OrdinalIgnoreCase);
                foreach (var entry in document?.Users ?? new List<UserPlaybackPolicy>())
                {
                    var key = Normalise(entry.UserId);
                    if (key.Length > 0)
                    {
                        entry.UserId = key;
                        _cache[key] = entry;
                    }
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
            {
                // A node whose core.db is not ready yet still has to be able to play something.
                _logger.LogDebug(ex, "Could not read the playback policies; everyone gets the default");
                _cache = new Dictionary<string, UserPlaybackPolicy>(StringComparer.OrdinalIgnoreCase);
            }

            return _cache;
        }
    }

    /// <summary>Set one user's policy.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="policy">The policy.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The stored value.</returns>
    public async Task<UserPlaybackPolicy> SetAsync(
        string userId,
        PlaybackPolicy policy,
        CancellationToken cancellationToken)
    {
        var key = Normalise(userId);
        if (key.Length == 0)
        {
            throw new ArgumentException("A playback policy needs a user id.", nameof(userId));
        }

        var entry = new UserPlaybackPolicy
        {
            UserId = key,
            Policy = PolicyNames.Wire(policy),
            UpdatedAt = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
        };

        List<UserPlaybackPolicy> users;
        lock (_gate)
        {
            var all = new Dictionary<string, UserPlaybackPolicy>(All(), StringComparer.OrdinalIgnoreCase)
            {
                [key] = entry,
            };
            _cache = all;
            users = new List<UserPlaybackPolicy>(all.Values);
        }

        await _settings
            .PutDocumentAsync(StorageKey, new PolicyDocument { Users = users }, cancellationToken)
            .ConfigureAwait(false);
        _logger.LogInformation("Playback policy for {User} is now {Policy}", key, entry.Policy);
        return entry;
    }

    /// <summary>
    /// A Jellyfin user id in the one spelling this store keys on.
    /// </summary>
    /// <remarks>
    /// Jellyfin hands the same id out as <c>N</c> format in some places and <c>D</c> format in
    /// others, and the app passes back whichever it was given. Normalising here is what stops a
    /// user who set Quality-first on one screen from reading as unset on another.
    /// </remarks>
    private static string Normalise(string? userId)
        => Guid.TryParse(userId, out var parsed)
            ? parsed.ToString("N", System.Globalization.CultureInfo.InvariantCulture)
            : string.Empty;

    /// <summary>The stored shape: every user's choice in one document.</summary>
    private sealed class PolicyDocument
    {
        public List<UserPlaybackPolicy> Users { get; set; } = new();
    }
}
