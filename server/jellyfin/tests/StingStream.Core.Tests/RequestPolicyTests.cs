using System.Collections.Generic;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The policy rule, which decides whether somebody else's request may spend this group's bandwidth.
/// </summary>
/// <remarks>
/// The one piece of M6 whose being wrong is a permissions failure rather than an inconvenience, so
/// it is a pure static function and every branch is asserted here rather than inferred from an
/// end-to-end run.
/// </remarks>
public class RequestPolicyTests
{
    private static RequestPolicy Policy(string mode, int quota = 0) => new()
    {
        AutoApprove = mode,
        WeeklyQuota = quota,
    };

    [Fact]
    public void Everyone_approves_an_ordinary_member()
    {
        Assert.True(RequestService.IsAutoApproved(
            Policy(AutoApprove.Everyone),
            isAdministrator: false,
            isTrusted: false));
    }

    [Fact]
    public void Trusted_approves_only_the_trusted()
    {
        var policy = Policy(AutoApprove.Trusted);
        Assert.True(RequestService.IsAutoApproved(policy, isAdministrator: false, isTrusted: true));
        Assert.False(RequestService.IsAutoApproved(policy, isAdministrator: false, isTrusted: false));
    }

    [Fact]
    public void Admins_only_holds_everybody_else_back()
    {
        var policy = Policy(AutoApprove.AdminsOnly);
        Assert.False(RequestService.IsAutoApproved(policy, isAdministrator: false, isTrusted: false));
        // Trusted is not a licence under this mode. Being on the trusted list means "I do not need
        // watching", not "I outrank the policy the administrator chose".
        Assert.False(RequestService.IsAutoApproved(policy, isAdministrator: false, isTrusted: true));
    }

    [Fact]
    public void An_administrator_is_approved_under_every_mode()
    {
        // Not a special case so much as the definition: an administrator can change the policy, so
        // making them queue for an approval they could grant themselves is theatre.
        foreach (var mode in new[] { AutoApprove.Everyone, AutoApprove.Trusted, AutoApprove.AdminsOnly })
        {
            Assert.True(
                RequestService.IsAutoApproved(Policy(mode), isAdministrator: true, isTrusted: false),
                $"an administrator should be auto-approved under {mode}");
        }
    }

    [Fact]
    public void An_unknown_mode_holds_the_request_rather_than_letting_it_through()
    {
        // A hand-edited row, or a policy written by a newer build. Failing closed is the only safe
        // direction: the cost of being wrong the other way is somebody else's bandwidth.
        Assert.False(RequestService.IsAutoApproved(
            Policy("whatever-this-is"),
            isAdministrator: false,
            isTrusted: true));
    }

    [Fact]
    public void A_personal_quota_beats_the_group_one()
    {
        Assert.Equal(3, RequestService.EffectiveQuota(Policy(AutoApprove.Trusted, quota: 10), personalQuota: 3));
    }

    [Fact]
    public void No_personal_quota_falls_back_to_the_group()
    {
        Assert.Equal(10, RequestService.EffectiveQuota(Policy(AutoApprove.Trusted, quota: 10), personalQuota: 0));
    }

    [Fact]
    public void Zero_everywhere_means_unlimited()
    {
        Assert.Equal(0, RequestService.EffectiveQuota(Policy(AutoApprove.Trusted), personalQuota: 0));
    }

    [Theory]
    [InlineData("everyone", AutoApprove.Everyone)]
    [InlineData("TRUSTED", AutoApprove.Trusted)]
    [InlineData(" admins_only ", AutoApprove.AdminsOnly)]
    [InlineData("admins", AutoApprove.AdminsOnly)]
    [InlineData("adminsOnly", AutoApprove.AdminsOnly)]
    public void Modes_parse_from_the_spellings_a_request_might_carry(string given, string expected)
    {
        Assert.Equal(expected, AutoApprove.Parse(given));
    }

    [Theory]
    [InlineData("")]
    [InlineData("nobody")]
    [InlineData(null)]
    public void An_unparseable_mode_is_null_rather_than_a_default(string? given)
    {
        // Null, so the controller can answer 400 with the allowed list. Quietly defaulting to
        // `trusted` would mean a typo in an administrator's request silently loosened the policy.
        Assert.Null(AutoApprove.Parse(given));
    }

    [Fact]
    public void Seasons_from_two_requests_merge_into_one_sorted_set()
    {
        Assert.Equal(new List<int> { 1, 2, 3 }, RequestService.MergeSeasons(new[] { 3, 1 }, new[] { 2, 1 }));
    }

    [Fact]
    public void Merging_seasons_drops_the_specials_folder_and_nonsense()
    {
        // Season 0 is specials. "The whole show" to a person does not include the Christmas special
        // nobody asked for, and a negative season number is a bug on the way in.
        Assert.Equal(new List<int> { 1 }, RequestService.MergeSeasons(new[] { 0, 1, -4 }, null));
    }

    [Fact]
    public void Merging_nothing_with_nothing_means_every_season()
    {
        Assert.Empty(RequestService.MergeSeasons(null, null));
    }

    [Fact]
    public void An_open_request_is_one_that_can_still_change_on_its_own()
    {
        Assert.True(RequestStates.IsOpen(RequestStates.Pending));
        Assert.True(RequestStates.IsOpen(RequestStates.Approved));
        Assert.True(RequestStates.IsOpen(RequestStates.Fulfilling));
        Assert.False(RequestStates.IsOpen(RequestStates.Available));
        Assert.False(RequestStates.IsOpen(RequestStates.Declined));
        Assert.False(RequestStates.IsOpen(RequestStates.Failed));
    }
}
