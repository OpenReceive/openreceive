# WordPress hosting requirements

The OpenReceive plugin for WooCommerce runs inside your WordPress site, so your
host's PHP setup decides whether it can run. Most hosts meet every requirement
except one: the PHP **GMP** extension, which many hosts leave off and some
cannot add at all. Check this before you install.

## What the plugin needs

- 64-bit PHP 8.2 or newer
- the PHP **GMP** extension, used by the bundled elliptic-curve code
- the PHP **sodium** extension. WordPress's built-in sodium polyfill does not
  count.
- MySQL 8 or MariaDB 10.5+, with InnoDB tables. WordPress on SQLite is not
  supported.
- WordPress 6.6+ and WooCommerce 9+

WP-CLI and SSH are optional. Every setup step also works in the WordPress admin.

## How to check your site

WordPress's **Site Health** screen cannot answer this. It lists no PHP
extensions and never checks GMP. Its "libsodium" test also passes when only
the polyfill is present.

Use one of these instead:

- **Activate the plugin.** If GMP, sodium or 64-bit PHP is missing, activation
  stops with "OpenReceive requires 64-bit PHP with the sodium and GMP
  extensions" and changes nothing.
- **Check the host's PHP info page.** Many control panels show the loaded
  extensions, for example Hostinger's hPanel (**Advanced → PHP Info**). Look
  for `gmp` and `sodium`.
- **After activation,** open **WooCommerce → Settings → Payments →
  OpenReceive**. The Doctor panel checks the PHP that serves your store.

`php -m` and `wp eval` over SSH test the command-line PHP. On many hosts that
is a different PHP from the one that serves your site, so a pass there proves
nothing about the web PHP. The plugin needs both.

## Hosts we checked

Checked against each host's own documentation in October 2026. Hosts change
their platforms, so confirm with yours before relying on this.

| Host | GMP | How to get it |
| --- | --- | --- |
| WordPress.com (Business and Commerce plans) | Enabled | Nothing to do. GMP and sodium are both on ([PHP environment](https://wordpress.com/support/php-environment/)). |
| Kinsta | On request | Ask support to enable GMP. It is not in the default module list ([modules](https://kinsta.com/docs/wordpress-hosting/php/wordpress-php-modules/)). |
| DreamHost | Off by default | Panel: **Manage Websites → Settings → PHP → Extensions → Modify**, then enable `gmp` ([DreamHost help](https://help.dreamhost.com/hc/en-us/articles/214893957)). |
| WPX | Off by default | Control panel: **PHP → your site → PHP Modules for current PHP version → GMP → Save** ([WPX](https://wpx.net/kb/how-can-i-manage-php-modules-on-my-websites/)). |
| WP Engine | Fixed set | Check its PHP info page for `gmp`. If it is missing, WP Engine cannot add it: its modules "cannot be modified, removed, or added" ([platform settings](https://wpengine.com/support/platform-settings/)). |
| Flywheel | Not available | GMP is not offered and cannot be added ([PHP on Flywheel](https://getflywheel.com/wordpress-support/php-on-flywheel/)). |
| Pressable | Not available | GMP is not in Pressable's extension list, and its PHP settings cannot be changed ([Pressable](https://pressable.com/knowledgebase/php-info-limitations-pressable/)). |
| IONOS shared hosting | Fixed set | Check its PHP info page for `gmp`. On shared hosting, a missing module cannot be added later ([IONOS](https://www.ionos.com/help/hosting/using-php-for-web-projects/displaying-php-configuration-with-a-phpinfo-script/)). |

For other hosts, use the control-panel steps below, or ask support: "Please
enable the PHP GMP and sodium extensions for PHP 8.2 or newer, for both the
website and the command line."

## Control panels

**cPanel with CloudLinux** (the most common shared-hosting setup): open
**Software → Select PHP Version**, choose a version (not "native"), then open
the **Extensions** tab and tick `gmp` and `sodium`. Changes save as you tick.

**cPanel without the PHP selector:** you cannot add extensions yourself. On
shared hosting, ask the host. On your own server, an administrator installs
`ea-php82-php-gmp` (or the package matching your PHP version) in **WHM →
EasyApache 4 → Customize → PHP Extensions**.

**Plesk:** an administrator enables the extension in **Tools & Settings → PHP
Settings**, under the PHP handler your site uses. A Plesk customer account
usually cannot.

**Your own server or container:** see
[Enable GMP in both PHP runtimes](quickstart-woocommerce.md#enable-gmp-in-both-php-runtimes)
in the WooCommerce quickstart for Debian, Ubuntu, Alpine and the official
WordPress Docker images.

## If your host cannot enable GMP

The plugin cannot run without GMP, and there is no workaround. Move the store
to a host or plan that offers GMP, such as one in the table above, or to a VPS
where you control PHP.
