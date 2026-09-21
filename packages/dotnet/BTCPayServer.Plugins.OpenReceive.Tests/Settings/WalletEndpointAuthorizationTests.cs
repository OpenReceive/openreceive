using System.Security.Claims;
using BTCPayServer.Plugins.OpenReceive.Settings;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Logging.Abstractions;
using OpenReceive.TestkitNwc;

namespace BTCPayServer.Plugins.OpenReceive.Tests.Settings;

public sealed class WalletEndpointAuthorizationTests
{
    private sealed class Authorization(bool allowed) : IAuthorizationService
    {
        public int Calls;
        public Task<AuthorizationResult> AuthorizeAsync(ClaimsPrincipal user, object? resource, IEnumerable<IAuthorizationRequirement> requirements)
        {
            Calls++;
            return Task.FromResult(allowed ? AuthorizationResult.Success() : AuthorizationResult.Failed());
        }
        public Task<AuthorizationResult> AuthorizeAsync(ClaimsPrincipal user, object? resource, string policyName) =>
            AuthorizeAsync(user, resource, Array.Empty<IAuthorizationRequirement>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task All_relay_hosts_are_checked_before_client_construction(bool admin)
    {
        var authorizer = new Authorization(admin);
        var settings = new OpenReceiveSettingsService(null!, null!, null!, null!, null!, authorizer, null!, NullLogger<OpenReceiveSettingsService>.Instance);
        var wallet = new TestkitWalletService(new InMemoryWalletBackend(), new TestkitWalletOptions());
        var uri = wallet.NwcUri(new Uri("wss://relay.example.org")) + "&relay=" + Uri.EscapeDataString("wss://127.0.0.1:7447");
        var user = new ClaimsPrincipal(new ClaimsIdentity());
        var error = await settings.WalletEndpointErrorAsync(uri, user);
        Assert.Equal(admin, error is null);
        Assert.Equal(1, authorizer.Calls);
        if (!admin)
        {
            // Null client dependencies are intentional: any construction before authorization
            // would throw. Both the typed and saved-string path use this same boundary.
            var rejected = await settings.CreateAuthorizedClientAsync(uri, false, user);
            Assert.Null(rejected.Client);
            Assert.DoesNotContain(wallet.ConnectionSecretHex, rejected.Error!);
            Assert.Contains("server admin", rejected.Error);
        }
        Assert.Null(await settings.WalletEndpointErrorAsync(wallet.NwcUri(new Uri("wss://relay.example.org")), user));
    }
}
