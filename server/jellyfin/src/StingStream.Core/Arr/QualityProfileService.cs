using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Data;

namespace StingStream.Core.Arr;

/// <summary>
/// One quality profile, as StingStream models it across both arrs.
/// </summary>
/// <remarks>
/// <para>
/// The design decision <c>docs/UI-API-GAPS.md</c> gap 4 flagged, made: a profile is
/// <strong>shared and keyed on its name</strong>, not per-app and keyed on an id. Radarr and Sonarr
/// each assign their own integer ids, and a user who edits "1080p" expects both halves of their
/// library to follow — the whole premise of the Omniarr model is that there is one settings
/// document, not two.
/// </para>
/// <para>
/// What is deliberately <em>not</em> shared is the quality vocabulary. Radarr's definition list and
/// Sonarr's differ, so a profile is edited as <see cref="Tiers"/> — picture sizes — and each app is
/// given every quality it has at those sizes. <see cref="Items"/> and <see cref="Cutoff"/> remain for
/// a caller that wants to name qualities exactly.
/// </para>
/// </remarks>
public sealed class QualityProfileView
{
    /// <summary>The profile's name. This is its identity across both apps.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Which running managers hold a copy by this name: <c>radarr</c>, <c>sonarr</c>, both, or none
    /// while neither is running. The profile itself lives in StingStream either way.
    /// </summary>
    public List<string> Apps { get; set; } = new();

    /// <summary>Each app's own integer id for it, so a caller can cross-check against the arr.</summary>
    public Dictionary<string, int> Ids { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether the profile upgrades an existing file when a better release appears.</summary>
    public bool UpgradeAllowed { get; set; }

    /// <summary>The quality (or quality group) name at which upgrading stops.</summary>
    public string Cutoff { get; set; } = string.Empty;

    /// <summary>Allowed qualities, exactly as the app orders them.</summary>
    public List<QualityProfileItemView> Items { get; set; } = new();

    /// <summary>
    /// The picture sizes the profile allows, worst first: <c>sd</c>, <c>720p</c>, <c>1080p</c>,
    /// <c>2160p</c>.
    /// </summary>
    /// <remarks>
    /// On a write, a non-empty list wins over <see cref="Items"/> and <see cref="Cutoff"/>: each app is
    /// given every quality it has in these tiers, and stops upgrading at <see cref="CutoffTier"/>.
    /// </remarks>
    public List<string> Tiers { get; set; } = new();

    /// <summary>The tier at which upgrading stops. Empty when the cutoff belongs to no tier.</summary>
    public string CutoffTier { get; set; } = string.Empty;

    /// <summary>One of <see cref="BuiltInQualityProfiles"/>: it can be reset, and not deleted.</summary>
    public bool IsBuiltIn { get; set; }

    /// <summary>The default profile used when a title is added without naming one.</summary>
    public bool IsDefault { get; set; }

    /// <summary>
    /// Whether every running manager's copy says what StingStream's does.
    /// </summary>
    /// <remarks>
    /// False for the few seconds between a save and the sync that follows it, or when somebody
    /// edited a manager by hand. True when no manager is running: there is nothing to disagree.
    /// </remarks>
    public bool InSync { get; set; }

    /// <summary>Quality names the profile asked for that an app does not have, keyed by app.</summary>
    public Dictionary<string, List<string>> Unsupported { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>One quality, or one group of them, inside a profile.</summary>
public sealed class QualityProfileItemView
{
    /// <summary>The quality's name, e.g. <c>WEBDL-1080p</c>, or the group's, e.g. <c>WEB 1080p</c>.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Whether releases of this quality are accepted.</summary>
    public bool Allowed { get; set; }

    /// <summary>True when this is a group of interchangeable qualities rather than one quality.</summary>
    public bool IsGroup { get; set; }

    /// <summary>The group's members, empty for a plain quality.</summary>
    public List<QualityProfileItemView> Items { get; set; } = new();
}

/// <summary>The quality vocabulary each app has, so an editor can offer real choices.</summary>
public sealed class QualityVocabulary
{
    /// <summary>Quality and group names per app, in the app's own order.</summary>
    public Dictionary<string, List<string>> Apps { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Names every configured app understands — the safe set for a shared profile.</summary>
    public List<string> Shared { get; set; } = new();
}

/// <summary>What a write did, per app.</summary>
public sealed class QualityProfileWriteResult
{
    /// <summary>
    /// True when the failure was "no app has that profile" rather than "an app refused".
    /// </summary>
    /// <remarks>
    /// The two need different status codes and read completely differently to a person: a profile
    /// that is still in use by forty films is a 400 with the app's own sentence, and one that was
    /// never there is a 404.
    /// </remarks>
    public bool NotFound { get; set; }

    /// <summary>The profile as it is now stored.</summary>
    public QualityProfileView? Profile { get; set; }

    /// <summary>One line per app: what was created, updated, deleted or refused.</summary>
    public List<string> Detail { get; set; } = new();

    /// <summary>False when at least one app refused.</summary>
    public bool Ok { get; set; }

    /// <summary>Why, when <see cref="Ok"/> is false.</summary>
    public string Message { get; set; } = string.Empty;
}

/// <summary>Which managers have had their stock profiles replaced, and which have been read into the store.</summary>
public sealed class QualityProfileSeedMarker
{
    /// <summary>Settings key this document is stored under in <c>core.db</c>.</summary>
    public const string StorageKey = "quality-profiles-seeded";

    /// <summary>
    /// Managers whose stock set (Any, SD, HD-720p and so on) has been replaced by the store's.
    /// </summary>
    public List<string> Apps { get; set; } = new();

    /// <summary>
    /// Managers whose own profiles have been copied into <see cref="SharedSettings.QualityProfiles"/>.
    /// </summary>
    /// <remarks>
    /// Only a manager already in <see cref="Apps"/> is copied from. One that is not still holds its
    /// stock set, which is exactly what seeding replaces, and importing it would bring back profiles
    /// nobody made.
    /// </remarks>
    public List<string> Adopted { get; set; } = new();
}

/// <summary>
/// Quality profiles: StingStream's own list, and the copies of it each manager is given.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="SharedSettings.QualityProfiles"/> is the list. Reading, creating, editing, resetting
/// and deleting a profile touch only that, so all of it works while neither manager is running,
/// which is most of the time on a node with no indexer yet. <see cref="SyncAsync"/> is the other
/// half: a step of <see cref="OmniarrSyncService.SyncOneAsync"/>, which <see cref="SyncRetryWorker"/>
/// runs whenever a manager is behind the settings, including the first time it comes up.
/// </para>
/// <para>
/// A manager's copy is built the way <see cref="OmniarrSyncService"/> builds everything: fetch the
/// manager's own schema or existing profile, fill in what StingStream has an opinion about, post it
/// back. The schema is what carries each quality's integer id, source and resolution, none of which
/// StingStream stores.
/// </para>
/// <para>
/// Profiles are compared at the level they are stored, tiers and cutoff tier, so a profile copied in
/// from a manager is never rewritten until somebody edits it: one that allows only
/// <c>WEBDL-1080p</c> stores as "1080p" and matches its own copy.
/// </para>
/// </remarks>
public sealed class QualityProfileService
{
    /// <summary>The resource name a deleted profile is retired under.</summary>
    public const string RetiredResource = "qualityprofile";

    /// <summary>
    /// How long a request a person is waiting on spends asking the managers anything.
    /// </summary>
    /// <remarks>
    /// The list is answered from the store; the managers only add which of them hold each profile.
    /// A manager that is starting refuses the connection at once, but one that is migrating its
    /// database accepts it and says nothing, and the arr client's own timeout is a minute.
    /// </remarks>
    public static readonly TimeSpan ReadBudget = TimeSpan.FromSeconds(3);

    /// <summary>How long a delete spends finding out whether any title uses the profile.</summary>
    public static readonly TimeSpan InUseBudget = TimeSpan.FromSeconds(5);

    private readonly ArrClientFactory _factory;
    private readonly SettingsStore _settings;
    private readonly ILogger<QualityProfileService> _logger;

    public QualityProfileService(
        ArrClientFactory factory,
        SettingsStore settings,
        ILogger<QualityProfileService> logger)
    {
        _factory = factory;
        _settings = settings;
        _logger = logger;
    }

    // --- the store -----------------------------------------------------------

    /// <summary>
    /// Fill an empty store with the built-ins, and point an unset default at one of them.
    /// </summary>
    /// <param name="settings">The settings. Mutated.</param>
    /// <returns>True when anything changed.</returns>
    public static bool Initialize(SharedSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (settings.QualityProfiles.Count > 0)
        {
            return false;
        }

        foreach (var builtIn in BuiltInQualityProfiles.All)
        {
            var entry = ToSettings(builtIn);
            entry.Provisional = true;
            settings.QualityProfiles.Add(entry);
        }

        // Only when unset. A node from before the store may default to a profile of its own that is
        // still inside a manager, and comes back into the list when that manager is next read.
        if (string.IsNullOrWhiteSpace(settings.DefaultQualityProfileName))
        {
            settings.DefaultQualityProfileName = BuiltInQualityProfiles.DefaultName;
        }

        return true;
    }

    /// <summary>
    /// Copy one manager's profiles into the store: every name it does not have yet, and every
    /// built-in it still holds only provisionally.
    /// </summary>
    /// <param name="settings">The settings. Mutated.</param>
    /// <param name="managerProfiles">The manager's <c>qualityprofile</c> resources.</param>
    /// <returns>The names added or replaced.</returns>
    /// <remarks>
    /// A retired name is skipped: it was deleted here, and its copy in the manager is on its way out.
    /// Idempotent, so two readers adopting the same manager at once end up where one would.
    /// </remarks>
    public static List<string> Adopt(SharedSettings settings, IEnumerable<JsonObject> managerProfiles)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(managerProfiles);

        var changed = new List<string>();
        foreach (var raw in managerProfiles)
        {
            var incoming = FromManager(raw);
            if (string.IsNullOrWhiteSpace(incoming.Name) || IsRetired(settings, incoming.Name))
            {
                continue;
            }

            var index = settings.QualityProfiles.FindIndex(
                p => string.Equals(p.Name, incoming.Name, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
            {
                settings.QualityProfiles.Add(incoming);
                changed.Add(incoming.Name);
            }
            else if (settings.QualityProfiles[index].Provisional)
            {
                incoming.Name = settings.QualityProfiles[index].Name;
                settings.QualityProfiles[index] = incoming;
                changed.Add(incoming.Name);
            }
        }

        return changed;
    }

    /// <summary>
    /// The store, filled in first if this node has never read it.
    /// </summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The profiles.</returns>
    public async Task<List<QualityProfileSettings>> EnsureStoreAsync(CancellationToken ct = default)
    {
        var current = _settings.Get();
        if (current.QualityProfiles.Count > 0)
        {
            return current.QualityProfiles;
        }

        var saved = await _settings.UpdateAsync(s => Initialize(s), ct).ConfigureAwait(false);
        return saved.QualityProfiles;
    }

    /// <summary>One stored profile by name, or null. Never asks a manager.</summary>
    public QualityProfileSettings? Find(string? name)
        => _settings.Get().QualityProfiles.FirstOrDefault(
            p => string.Equals(p.Name, name?.Trim(), StringComparison.OrdinalIgnoreCase));

    // --- reading -------------------------------------------------------------

    /// <summary>Every profile, from the store, with which running manager holds each.</summary>
    public Task<List<QualityProfileView>> ListAsync(CancellationToken ct = default)
        => ListAsync(_factory.CreateAll(), ct);

    /// <summary>Every profile, from the store, with which of these managers holds each.</summary>
    /// <param name="clients">The managers to ask, within <see cref="ReadBudget"/>.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The profiles, built-ins first.</returns>
    public async Task<List<QualityProfileView>> ListAsync(IReadOnlyList<ArrClient> clients, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(clients);
        await EnsureStoreAsync(ct).ConfigureAwait(false);

        var held = await ReadManagersAsync(clients, ct).ConfigureAwait(false);
        foreach (var (app, profiles) in held)
        {
            await AdoptIfDueAsync(app, profiles, ct).ConfigureAwait(false);
        }

        return BuildViews(_settings.Get(), held);
    }

    /// <summary>One profile by name, or null.</summary>
    public async Task<QualityProfileView?> GetAsync(string name, CancellationToken ct = default)
    {
        var all = await ListAsync(ct).ConfigureAwait(false);
        return all.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>What qualities each app understands.</summary>
    public async Task<QualityVocabulary> VocabularyAsync(CancellationToken ct = default)
    {
        var result = new QualityVocabulary();
        var sets = new List<HashSet<string>>();

        foreach (var client in _factory.CreateAll())
        {
            JsonObject? schema;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(ReadBudget);
            try
            {
                schema = await client.QualityProfileSchemaAsync(budget.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is ArrApiException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
            {
                _logger.LogWarning(ex, "Could not read {App}'s quality-profile schema", client.Name);
                continue;
            }

            if (schema is null)
            {
                continue;
            }

            var names = Flatten(ReadItems(schema)).ToList();
            result.Apps[client.Name] = names;
            sets.Add(new HashSet<string>(names, StringComparer.OrdinalIgnoreCase));
        }

        if (sets.Count > 0)
        {
            var shared = sets[0];
            foreach (var other in sets.Skip(1))
            {
                shared.IntersectWith(other);
            }

            var order = result.Apps.Values.FirstOrDefault() ?? new List<string>();
            result.Shared = order.Where(shared.Contains).ToList();
        }

        return result;
    }

    // --- writing -------------------------------------------------------------

    /// <summary>Create or replace a profile in the store. The managers follow on the next sync.</summary>
    /// <param name="desired">The profile, keyed on <see cref="QualityProfileView.Name"/>.</param>
    /// <param name="mustExist">True for an update: refuse when there is no such profile.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>What happened.</returns>
    public async Task<QualityProfileWriteResult> SaveAsync(
        QualityProfileView desired,
        bool mustExist,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(desired);
        var result = new QualityProfileWriteResult();

        var entry = ToSettings(desired);
        if (string.IsNullOrWhiteSpace(entry.Name))
        {
            result.Message = "Give the profile a name.";
            return result;
        }

        if (entry.Tiers.Count == 0)
        {
            result.Message = "Choose at least one quality.";
            return result;
        }

        await EnsureStoreAsync(ct).ConfigureAwait(false);
        if (mustExist && Find(entry.Name) is null)
        {
            result.NotFound = true;
            result.Message = $"There is no quality profile called \"{entry.Name}\".";
            return result;
        }

        var saved = await _settings.UpdateAsync(
            s =>
            {
                var index = s.QualityProfiles.FindIndex(
                    p => string.Equals(p.Name, entry.Name, StringComparison.OrdinalIgnoreCase));
                if (index < 0)
                {
                    s.QualityProfiles.Add(entry);
                }
                else
                {
                    // Keep the stored spelling: it is the name the managers already know it by.
                    entry.Name = s.QualityProfiles[index].Name;
                    s.QualityProfiles[index] = entry;
                }

                s.Unretire(RetiredResource, entry.Name);
            },
            ct).ConfigureAwait(false);

        result.Ok = true;
        result.Detail.Add($"stored {entry.Name}");
        result.Profile = BuildViews(saved, new Dictionary<string, List<JsonObject>>())
            .FirstOrDefault(v => string.Equals(v.Name, entry.Name, StringComparison.OrdinalIgnoreCase));
        return result;
    }

    /// <summary>Put a built-in profile back the way it shipped.</summary>
    public async Task<QualityProfileWriteResult> ResetAsync(string name, CancellationToken ct = default)
    {
        var builtIn = BuiltInQualityProfiles.Find(name);
        if (builtIn is null)
        {
            return new QualityProfileWriteResult
            {
                NotFound = true,
                Message = $"\"{name}\" is not a built-in quality profile.",
            };
        }

        return await SaveAsync(BuiltInQualityProfiles.ToView(builtIn), mustExist: false, ct).ConfigureAwait(false);
    }

    /// <summary>Remove a profile, and retire its name in the managers.</summary>
    public Task<QualityProfileWriteResult> DeleteAsync(string name, CancellationToken ct = default)
        => DeleteAsync(name, _factory.CreateAll(), ct);

    /// <summary>Remove a profile, and retire its name in the managers.</summary>
    /// <param name="name">The profile's name.</param>
    /// <param name="clients">The managers to check for titles still using it.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>What happened.</returns>
    /// <remarks>
    /// Both managers refuse to delete a profile any title is filed under. When one is running, that
    /// is checked first and the delete refused with a sentence that says what to do, rather than
    /// removing the profile here and leaving it stuck there. When none is, nothing can be checked and
    /// the delete goes ahead; the sync that retires the name moves any title still on it to the
    /// default profile (<see cref="SyncAsync"/>).
    /// </remarks>
    public async Task<QualityProfileWriteResult> DeleteAsync(
        string name,
        IReadOnlyList<ArrClient> clients,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(clients);
        var result = new QualityProfileWriteResult();

        await EnsureStoreAsync(ct).ConfigureAwait(false);
        var stored = Find(name);
        if (stored is null)
        {
            result.NotFound = true;
            result.Message = $"There is no quality profile called \"{name}\".";
            return result;
        }

        if (BuiltInQualityProfiles.IsBuiltIn(stored.Name))
        {
            result.Message = "Built-in profiles can be reset, not deleted.";
            return result;
        }

        if (await IsInUseAsync(clients, stored.Name, ct).ConfigureAwait(false))
        {
            result.Message = "This profile is in use. Move its movies and TV shows to another profile first.";
            return result;
        }

        await _settings.UpdateAsync(
            s =>
            {
                s.QualityProfiles.RemoveAll(p => string.Equals(p.Name, stored.Name, StringComparison.OrdinalIgnoreCase));
                s.Retire(RetiredResource, stored.Name);
                if (string.Equals(s.DefaultQualityProfileName, stored.Name, StringComparison.OrdinalIgnoreCase))
                {
                    s.DefaultQualityProfileName = BuiltInQualityProfiles.DefaultName;
                }
            },
            ct).ConfigureAwait(false);

        result.Ok = true;
        result.Detail.Add($"deleted {stored.Name}");
        return result;
    }

    // --- sync ----------------------------------------------------------------

    /// <summary>
    /// Bring one manager's quality profiles into line with the store.
    /// </summary>
    /// <param name="client">The manager, already known to be answering.</param>
    /// <param name="status">Where each change is recorded.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <remarks>
    /// <list type="number">
    /// <item>The first time a manager is reached, its stock set is replaced: every stored profile is
    /// written over whatever shares its name (both managers ship an "Any" that takes cams and remuxes),
    /// and everything else is deleted. A stock profile a title already uses stays, and is copied into
    /// the store so it can be seen and deleted later.</item>
    /// <item>A manager seeded before profiles were stored here is copied into the store once
    /// (<see cref="Adopt"/>), so nothing made inside it is lost.</item>
    /// <item>After that, a stored profile the manager lacks is created, and one whose tiers, cutoff or
    /// upgrade setting differ is rewritten. Nothing else is touched.</item>
    /// <item>A retired name still present is deleted, after moving any title on it to the default
    /// profile. If the manager still refuses (an import list or collection uses it), it stays, the
    /// sync says so, and the next sync tries again.</item>
    /// </list>
    /// </remarks>
    /// <exception cref="ArrApiException">The manager could not be read, or refused a write.</exception>
    public async Task SyncAsync(ArrClient client, SyncStatus status, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(status);

        await EnsureStoreAsync(ct).ConfigureAwait(false);
        var marker = Marker();
        var firstContact = !marker.Apps.Contains(client.Name, StringComparer.OrdinalIgnoreCase);
        var existing = await client.QualityProfilesAsync(ct).ConfigureAwait(false);

        if (!firstContact)
        {
            var adopted = await AdoptIfDueAsync(client.Name, existing, ct).ConfigureAwait(false);
            if (adopted.Count > 0)
            {
                status.Detail.Add($"quality profile: kept {string.Join(", ", adopted)} from {client.Display}");
            }
        }

        var settings = _settings.Get();
        JsonObject? schema = null;
        foreach (var profile in settings.QualityProfiles)
        {
            // Imported from a manager and made of qualities in no tier: there is nothing here to
            // write, and the manager's own copy is the definition.
            if (profile.Tiers.Count == 0)
            {
                continue;
            }

            var current = existing.FirstOrDefault(p => string.Equals(
                p["name"]?.GetValue<string>(),
                profile.Name,
                StringComparison.OrdinalIgnoreCase));
            if (current is not null && !firstContact && Matches(profile, current))
            {
                continue;
            }

            JsonObject basis;
            if (current is not null)
            {
                basis = current.DeepClone().AsObject();
            }
            else
            {
                schema ??= await client.QualityProfileSchemaAsync(ct).ConfigureAwait(false)
                    ?? throw new ArrApiException($"{client.Name} returned no quality-profile schema.");
                basis = schema.DeepClone().AsObject();
            }

            var scratch = new QualityProfileWriteResult();
            if (!Prepare(basis, ToView(profile), client.Name, scratch))
            {
                status.Detail.AddRange(scratch.Detail.Select(d => $"quality profile {profile.Name}: {d}"));
                continue;
            }

            await WriteAsync(client, basis, current, ct).ConfigureAwait(false);
            status.Detail.Add($"quality profile: {(current is null ? "created" : "updated")} {profile.Name}");
        }

        var keep = new HashSet<string>(settings.QualityProfiles.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);
        var remove = firstContact
            ? existing.Select(p => p["name"]?.GetValue<string>()).OfType<string>().Where(n => !keep.Contains(n)).ToList()
            : settings.RetiredProviders
                .Where(r => string.Equals(r.Resource, RetiredResource, StringComparison.OrdinalIgnoreCase))
                .Select(r => r.Name)
                .Where(n => !keep.Contains(n))
                .ToList();

        if (remove.Count > 0)
        {
            var now = await client.QualityProfilesAsync(ct).ConfigureAwait(false);
            foreach (var profile in now)
            {
                var name = profile["name"]?.GetValue<string>();
                if (name is null
                    || !remove.Contains(name, StringComparer.OrdinalIgnoreCase)
                    || profile["id"]?.GetValue<int>() is not { } id)
                {
                    continue;
                }

                await RemoveAsync(client, name, id, now, settings, reassign: !firstContact, status, ct).ConfigureAwait(false);
            }
        }

        if (firstContact)
        {
            // Whatever survived was in use. It belongs in the list, or it could never be deleted.
            var left = await client.QualityProfilesAsync(ct).ConfigureAwait(false);
            if (left.Any(p => !keep.Contains(p["name"]?.GetValue<string>() ?? string.Empty)))
            {
                await _settings.UpdateAsync(s => Adopt(s, left), ct).ConfigureAwait(false);
            }

            marker = Marker();
            AddOnce(marker.Apps, client.Name);
            AddOnce(marker.Adopted, client.Name);
            await _settings.PutDocumentAsync(QualityProfileSeedMarker.StorageKey, marker, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Delete one profile from a manager, first moving its titles to the default when asked.
    /// </summary>
    private async Task RemoveAsync(
        ArrClient client,
        string name,
        int id,
        List<JsonObject> profiles,
        SharedSettings settings,
        bool reassign,
        SyncStatus status,
        CancellationToken ct)
    {
        var path = string.Create(CultureInfo.InvariantCulture, $"qualityprofile/{id}");
        try
        {
            await client.DeleteAsync(path, ct).ConfigureAwait(false);
            status.Detail.Add($"quality profile: removed {name}");
            return;
        }
        catch (ArrApiException ex) when (ex.Status is not null && reassign)
        {
            _logger.LogInformation(ex, "{App} refused to delete quality profile {Name}; moving its titles", client.Name, name);
        }
        catch (ArrApiException ex) when (ex.Status is not null)
        {
            // First contact: a stock profile a title already uses. It stays, and is adopted.
            _logger.LogInformation(ex, "Kept {App}'s quality profile {Name}", client.Name, name);
            status.Detail.Add($"quality profile: kept {name} (in use)");
            return;
        }

        var target = TargetFor(profiles, settings, id);
        if (target is null)
        {
            status.Detail.Add($"quality profile: kept {name} (in use, and no other profile to move titles to)");
            return;
        }

        var moved = await MoveTitlesAsync(client, id, target.Value, ct).ConfigureAwait(false);
        try
        {
            await client.DeleteAsync(path, ct).ConfigureAwait(false);
            status.Detail.Add($"quality profile: moved {moved} title(s) off {name} and removed it");
        }
        catch (ArrApiException ex) when (ex.Status is not null)
        {
            _logger.LogWarning(ex, "{App} still refuses to delete quality profile {Name}", client.Name, name);
            status.Detail.Add($"quality profile: kept {name} (still in use: {ArrClient.DescribeValidationFailure(ex.Body ?? ex.Message, ex.Status.Value)})");
        }
    }

    /// <summary>The id of the profile titles move to when theirs is retired.</summary>
    private static int? TargetFor(List<JsonObject> profiles, SharedSettings settings, int retiredId)
    {
        int? IdOf(string? name) => profiles
            .Where(p => string.Equals(p["name"]?.GetValue<string>(), name, StringComparison.OrdinalIgnoreCase))
            .Select(p => p["id"]?.GetValue<int>())
            .FirstOrDefault(i => i is not null && i != retiredId);

        return IdOf(settings.DefaultQualityProfileName)
            ?? IdOf(BuiltInQualityProfiles.DefaultName)
            ?? settings.QualityProfiles.Select(p => IdOf(p.Name)).FirstOrDefault(i => i is not null);
    }

    /// <summary>Move every movie or show on one profile to another, through the manager's bulk editor.</summary>
    private static async Task<int> MoveTitlesAsync(ArrClient client, int from, int to, CancellationToken ct)
    {
        var ids = (await client.ListAsync(client.LibraryResource, ct).ConfigureAwait(false))
            .Where(t => t["qualityProfileId"]?.GetValue<int>() == from)
            .Select(t => t["id"]?.GetValue<int>())
            .OfType<int>()
            .ToList();
        if (ids.Count == 0)
        {
            return 0;
        }

        var idList = new JsonArray();
        foreach (var id in ids)
        {
            idList.Add(id);
        }

        var body = new JsonObject
        {
            [client.Kind == ArrKind.Radarr ? "movieIds" : "seriesIds"] = idList,
            ["qualityProfileId"] = to,
        };
        await client.PutAsync($"{client.LibraryResource}/editor", body, ct).ConfigureAwait(false);
        return ids.Count;
    }

    // --- helpers ---------------------------------------------------------------

    private QualityProfileSeedMarker Marker()
        => _settings.GetDocument<QualityProfileSeedMarker>(QualityProfileSeedMarker.StorageKey)
            ?? new QualityProfileSeedMarker();

    private static void AddOnce(List<string> list, string value)
    {
        if (!list.Contains(value, StringComparer.OrdinalIgnoreCase))
        {
            list.Add(value);
        }
    }

    private static bool IsRetired(SharedSettings settings, string name)
        => settings.RetiredProviders.Any(r =>
            string.Equals(r.Resource, RetiredResource, StringComparison.OrdinalIgnoreCase)
            && string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Copy a seeded manager's profiles into the store, once.</summary>
    /// <returns>The names that came in.</returns>
    private async Task<List<string>> AdoptIfDueAsync(string app, List<JsonObject> profiles, CancellationToken ct)
    {
        var marker = Marker();
        if (!marker.Apps.Contains(app, StringComparer.OrdinalIgnoreCase)
            || marker.Adopted.Contains(app, StringComparer.OrdinalIgnoreCase))
        {
            return new List<string>();
        }

        var changed = new List<string>();
        await _settings.UpdateAsync(s => changed = Adopt(s, profiles), ct).ConfigureAwait(false);

        marker = Marker();
        AddOnce(marker.Adopted, app);
        await _settings.PutDocumentAsync(QualityProfileSeedMarker.StorageKey, marker, ct).ConfigureAwait(false);
        if (changed.Count > 0)
        {
            _logger.LogInformation("Copied {App}'s quality profiles into StingStream: {Names}", app, string.Join(", ", changed));
        }

        return changed;
    }

    /// <summary>Each manager's profiles, from those that answer within <see cref="ReadBudget"/>.</summary>
    private async Task<Dictionary<string, List<JsonObject>>> ReadManagersAsync(
        IReadOnlyList<ArrClient> clients,
        CancellationToken ct)
    {
        var held = new Dictionary<string, List<JsonObject>>(StringComparer.OrdinalIgnoreCase);
        if (clients.Count == 0)
        {
            return held;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(ReadBudget);
        var reads = clients.Select(async c =>
        {
            try
            {
                return (c.Name, Profiles: await c.QualityProfilesAsync(budget.Token).ConfigureAwait(false));
            }
            catch (Exception ex) when (ex is ArrApiException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
            {
                _logger.LogDebug(ex, "{App} did not answer for its quality profiles", c.Name);
                return (c.Name, Profiles: (List<JsonObject>?)null);
            }
        }).ToList();

        foreach (var (app, profiles) in await Task.WhenAll(reads).ConfigureAwait(false))
        {
            if (profiles is not null)
            {
                held[app] = profiles;
            }
        }

        return held;
    }

    /// <summary>Whether any running manager has a title on this profile. False when none can say.</summary>
    private async Task<bool> IsInUseAsync(IReadOnlyList<ArrClient> clients, string name, CancellationToken ct)
    {
        if (clients.Count == 0)
        {
            return false;
        }

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(InUseBudget);
        var checks = clients.Select(async c =>
        {
            try
            {
                var profile = await c.QualityProfileByNameAsync(name, budget.Token).ConfigureAwait(false);
                if (profile?["id"]?.GetValue<int>() is not { } id)
                {
                    return false;
                }

                var titles = await c.ListAsync(c.LibraryResource, budget.Token).ConfigureAwait(false);
                return titles.Any(t => t["qualityProfileId"]?.GetValue<int>() == id);
            }
            catch (Exception ex) when (ex is ArrApiException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
            {
                _logger.LogDebug(ex, "{App} did not answer whether quality profile {Name} is in use", c.Name, name);
                return false;
            }
        }).ToList();

        return (await Task.WhenAll(checks).ConfigureAwait(false)).Any(inUse => inUse);
    }

    /// <summary>The list as the API reports it: the store, annotated with what each manager holds.</summary>
    /// <param name="settings">The settings, for the store and the default.</param>
    /// <param name="held">Each manager that answered, and its profiles.</param>
    /// <returns>The views, built-ins first.</returns>
    public static List<QualityProfileView> BuildViews(
        SharedSettings settings,
        IReadOnlyDictionary<string, List<JsonObject>> held)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(held);

        var views = new List<QualityProfileView>();
        foreach (var stored in settings.QualityProfiles)
        {
            var view = ToView(stored);
            view.IsBuiltIn = BuiltInQualityProfiles.IsBuiltIn(stored.Name);
            view.IsDefault = string.Equals(stored.Name, settings.DefaultQualityProfileName, StringComparison.OrdinalIgnoreCase);
            view.InSync = true;

            foreach (var (app, profiles) in held)
            {
                var raw = profiles.FirstOrDefault(p => string.Equals(
                    p["name"]?.GetValue<string>(),
                    stored.Name,
                    StringComparison.OrdinalIgnoreCase));
                if (raw is null)
                {
                    view.InSync = false;
                    continue;
                }

                view.Apps.Add(app);
                if (raw["id"]?.GetValue<int>() is { } id)
                {
                    view.Ids[app] = id;
                }

                if (stored.Tiers.Count > 0 && !Matches(stored, raw))
                {
                    view.InSync = false;
                }
            }

            views.Add(view);
        }

        return views
            .OrderBy(v => BuiltInQualityProfiles.Rank(v.Name))
            .ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>A manager's profile, as the store would hold it.</summary>
    public static QualityProfileSettings FromManager(JsonObject raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        return new QualityProfileSettings
        {
            Name = raw["name"]?.GetValue<string>()?.Trim() ?? string.Empty,
            UpgradeAllowed = raw["upgradeAllowed"]?.GetValue<bool>() ?? false,
            Tiers = QualityTiers.Of(Flatten(ReadItems(raw).Where(i => i.Allowed))),
            CutoffTier = QualityTiers.TierOf(CutoffName(raw)) ?? string.Empty,
        };
    }

    /// <summary>Whether a manager's copy already says what the stored profile says.</summary>
    public static bool Matches(QualityProfileSettings stored, JsonObject raw)
    {
        ArgumentNullException.ThrowIfNull(stored);
        var actual = FromManager(raw);
        var wanted = QualityTiers.All.Where(t => stored.Tiers.Contains(t, StringComparer.OrdinalIgnoreCase));
        return actual.UpgradeAllowed == stored.UpgradeAllowed
            && actual.Tiers.SequenceEqual(wanted, StringComparer.OrdinalIgnoreCase)
            && string.Equals(actual.CutoffTier, stored.CutoffTier, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// What a write asks the store to hold: tiers in order, and a cutoff among them.
    /// </summary>
    /// <remarks>
    /// A caller that names qualities (<see cref="QualityProfileView.Items"/>) rather than tiers is
    /// still understood: the tiers those qualities belong to are what is kept.
    /// </remarks>
    public static QualityProfileSettings ToSettings(QualityProfileView view)
    {
        ArgumentNullException.ThrowIfNull(view);
        var byTier = view.Tiers.Count > 0;
        var tiers = byTier
            ? QualityTiers.All.Where(t => view.Tiers.Contains(t, StringComparer.OrdinalIgnoreCase)).ToList()
            : QualityTiers.Of(Flatten(view.Items.Where(i => i.Allowed)));
        var cutoff = byTier ? view.CutoffTier : QualityTiers.TierOf(view.Cutoff) ?? string.Empty;
        if (!tiers.Contains(cutoff, StringComparer.OrdinalIgnoreCase))
        {
            cutoff = tiers.LastOrDefault() ?? string.Empty;
        }

        return new QualityProfileSettings
        {
            Name = view.Name?.Trim() ?? string.Empty,
            Tiers = tiers,
            CutoffTier = QualityTiers.All.FirstOrDefault(t => string.Equals(t, cutoff, StringComparison.OrdinalIgnoreCase)) ?? string.Empty,
            UpgradeAllowed = view.UpgradeAllowed,
        };
    }

    private static QualityProfileSettings ToSettings(BuiltInQualityProfile builtIn)
        => ToSettings(BuiltInQualityProfiles.ToView(builtIn));

    private static QualityProfileView ToView(QualityProfileSettings stored) => new()
    {
        Name = stored.Name,
        Tiers = stored.Tiers.ToList(),
        CutoffTier = stored.CutoffTier,
        UpgradeAllowed = stored.UpgradeAllowed,
    };

    // --- mapping -----------------------------------------------------------

    /// <summary>
    /// Fill one app's profile resource from the shared model: name, upgrades, allowed set, cutoff.
    /// </summary>
    /// <returns>False when this app has nothing the profile asks for, so there is nothing to write.</returns>
    private static bool Prepare(JsonObject basis, QualityProfileView desired, string app, QualityProfileWriteResult result)
    {
        var target = desired;
        HashSet<string> allowed;

        if (desired.Tiers.Count > 0)
        {
            var (names, cutoff) = QualityTiers.Resolve(
                Flatten(ReadItems(basis)),
                desired.Tiers,
                desired.CutoffTier);
            if (names.Count == 0)
            {
                result.Detail.Add($"{app}: has no qualities in those sizes");
                return false;
            }

            allowed = names;
            target = new QualityProfileView { Name = desired.Name, Cutoff = cutoff };
            Apply(basis, target, allowed, out _);
        }
        else
        {
            allowed = new HashSet<string>(
                desired.Items.Where(i => i.Allowed).Select(i => i.Name),
                StringComparer.OrdinalIgnoreCase);
            var missing = Apply(basis, desired, allowed, out var cutoffFound);
            if (missing.Count > 0)
            {
                desired.Unsupported[app] = missing;
            }

            if (!cutoffFound)
            {
                result.Detail.Add(
                    $"{app}: cutoff \"{desired.Cutoff}\" is not one of its allowed qualities; "
                    + "used the lowest allowed one instead");
            }
        }

        basis["name"] = desired.Name;
        basis["upgradeAllowed"] = desired.UpgradeAllowed;
        return true;
    }

    private static async Task WriteAsync(ArrClient client, JsonObject basis, JsonObject? existing, CancellationToken ct)
    {
        if (existing is null)
        {
            basis["id"] = 0;
            await client.PostAsync("qualityprofile", basis, ct).ConfigureAwait(false);
            return;
        }

        var id = existing["id"]?.GetValue<int>() ?? 0;
        basis["id"] = id;
        await client
            .PutAsync(string.Create(CultureInfo.InvariantCulture, $"qualityprofile/{id}"), basis, ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Set <c>allowed</c> and <c>cutoff</c> on one app's profile resource from the shared model.
    /// </summary>
    /// <returns>The quality names the shared model asked for that this app does not have.</returns>
    public static List<string> Apply(
        JsonObject resource,
        QualityProfileView desired,
        HashSet<string> allowed,
        out bool cutoffFound)
    {
        cutoffFound = false;
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int? cutoffId = null;
        int? lowestAllowedId = null;

        if (resource["items"] is JsonArray items)
        {
            foreach (var item in items.OfType<JsonObject>())
            {
                var name = ItemName(item);
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                known.Add(name);
                var isAllowed = allowed.Contains(name);

                // A group is allowed when the group itself is named, or when any member is: the
                // shared model's list is flat, and a user asking for "WEBDL-1080p" inside Radarr's
                // "WEB 1080p" group means the group. Membership is therefore read in full *before*
                // anything is written -- writing as we go would leave every member before the one
                // that flipped the group carrying the wrong value.
                var members = item["items"] as JsonArray;
                var cutoffNamesThisItem =
                    string.Equals(name, desired.Cutoff, StringComparison.OrdinalIgnoreCase);
                if (members is { Count: > 0 })
                {
                    foreach (var memberName in members.OfType<JsonObject>().Select(ItemName))
                    {
                        if (string.IsNullOrEmpty(memberName))
                        {
                            continue;
                        }

                        known.Add(memberName);
                        if (allowed.Contains(memberName))
                        {
                            isAllowed = true;
                        }

                        // A cutoff naming a quality that lives *inside* a group resolves to the
                        // group. NzbDrone stores the cutoff as one id and a grouped quality does
                        // not have an addressable one of its own.
                        if (string.Equals(memberName, desired.Cutoff, StringComparison.OrdinalIgnoreCase))
                        {
                            cutoffNamesThisItem = true;
                        }
                    }

                    // NzbDrone requires every member of an allowed group to be allowed too; a group
                    // with a disallowed member fails validation.
                    foreach (var member in members.OfType<JsonObject>())
                    {
                        member["allowed"] = isAllowed;
                    }
                }

                item["allowed"] = isAllowed;

                // The cutoff is an id: a group's own id when it is a group, the quality's when not.
                var id = GroupOrQualityId(item);
                if (id is null)
                {
                    continue;
                }

                if (isAllowed)
                {
                    lowestAllowedId = id;
                    if (cutoffNamesThisItem)
                    {
                        cutoffId = id;
                        cutoffFound = true;
                    }
                }
            }
        }

        // A cutoff that is not allowed is rejected outright by both apps, so falling back to an
        // allowed quality is the only answer that stores at all.
        resource["cutoff"] = cutoffId ?? lowestAllowedId;

        return allowed.Where(a => !known.Contains(a)).OrderBy(a => a, StringComparer.Ordinal).ToList();
    }

    private static string ItemName(JsonObject item)
        => item["name"]?.GetValue<string>()
            ?? (item["quality"] as JsonObject)?["name"]?.GetValue<string>()
            ?? string.Empty;

    private static int? GroupOrQualityId(JsonObject item)
        => item["id"]?.GetValue<int>() ?? (item["quality"] as JsonObject)?["id"]?.GetValue<int>();

    private static List<QualityProfileItemView> ReadItems(JsonObject resource)
    {
        var result = new List<QualityProfileItemView>();
        if (resource["items"] is not JsonArray items)
        {
            return result;
        }

        foreach (var item in items.OfType<JsonObject>())
        {
            var name = ItemName(item);
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var view = new QualityProfileItemView
            {
                Name = name,
                Allowed = item["allowed"]?.GetValue<bool>() ?? false,
            };

            if (item["items"] is JsonArray members && members.Count > 0)
            {
                view.IsGroup = true;
                foreach (var member in members.OfType<JsonObject>())
                {
                    var memberName = ItemName(member);
                    if (string.IsNullOrEmpty(memberName))
                    {
                        continue;
                    }

                    view.Items.Add(new QualityProfileItemView
                    {
                        Name = memberName,
                        Allowed = member["allowed"]?.GetValue<bool>() ?? false,
                    });
                }
            }

            result.Add(view);
        }

        return result;
    }

    /// <summary>Every name in an item tree, groups and their members alike.</summary>
    public static IEnumerable<string> Flatten(IEnumerable<QualityProfileItemView> items)
    {
        foreach (var item in items)
        {
            yield return item.Name;
            foreach (var member in item.Items)
            {
                yield return member.Name;
            }
        }
    }

    private static string CutoffName(JsonObject profile)
    {
        var cutoff = profile["cutoff"]?.GetValue<int>();
        if (cutoff is null || profile["items"] is not JsonArray items)
        {
            return string.Empty;
        }

        foreach (var item in items.OfType<JsonObject>())
        {
            if (GroupOrQualityId(item) == cutoff)
            {
                return ItemName(item);
            }

            if (item["items"] is JsonArray members)
            {
                foreach (var member in members.OfType<JsonObject>())
                {
                    if (GroupOrQualityId(member) == cutoff)
                    {
                        return ItemName(member);
                    }
                }
            }
        }

        return string.Empty;
    }
}
