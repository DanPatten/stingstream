using System;
using StingStream.Core.FirstRun;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Who may be disabled, now that upstream's blanket "administrators cannot be disabled" is gone.
/// </summary>
public class AccountDisableGuardTests
{
    private static readonly Guid Owner = Guid.Parse("11111111111111111111111111111111");
    private static readonly Guid Admin = Guid.Parse("22222222222222222222222222222222");

    [Fact]
    public void AnotherAdministratorCanBeDisabled()
    {
        Assert.Equal(DisableRefusal.None, AccountDisableGuard.Decide(true, Admin, Owner, Owner.ToString("N")));
    }

    [Fact]
    public void TheOwnerCannotBeDisabledByAnybody()
    {
        Assert.Equal(DisableRefusal.Owner, AccountDisableGuard.Decide(true, Owner, Admin, Owner.ToString("N")));
        Assert.Equal(DisableRefusal.Owner, AccountDisableGuard.Decide(true, Owner, Guid.Empty, Owner.ToString("D")));
    }

    [Fact]
    public void TheOwnerLookingAtThemselvesIsToldTheOwnerRule()
    {
        Assert.Equal(DisableRefusal.Owner, AccountDisableGuard.Decide(true, Owner, Owner, Owner.ToString("N")));
    }

    [Fact]
    public void NobodyCanDisableThemselves()
    {
        Assert.Equal(DisableRefusal.Self, AccountDisableGuard.Decide(true, Admin, Admin, Owner.ToString("N")));
        Assert.Equal(DisableRefusal.Self, AccountDisableGuard.Decide(true, Admin, Admin, null));
    }

    [Fact]
    public void EnablingIsNeverRefused()
    {
        Assert.Equal(DisableRefusal.None, AccountDisableGuard.Decide(false, Owner, Owner, Owner.ToString("N")));
    }

    [Fact]
    public void AnApiKeyIsNeverSelf()
    {
        Assert.Equal(DisableRefusal.None, AccountDisableGuard.Decide(true, Admin, Guid.Empty, Owner.ToString("N")));
    }
}
