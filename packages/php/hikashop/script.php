<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

use Joomla\CMS\Factory;
use Joomla\CMS\Installer\InstallerScript;
use Joomla\Database\DatabaseInterface;

defined('_JEXEC') or die;

/**
 * The package's install steps. Before: PHP and HikaShop are checked, so a
 * site that cannot run the engine refuses the package instead of breaking at
 * checkout. After: both plugins are enabled and the engine's two tables are
 * made in Joomla's database. Uninstalling forgets the codes; the payment
 * tables stay, a record of the payments received.
 */
class pkg_openreceiveInstallerScript extends InstallerScript
{
    /** @var string */
    protected $minimumPhp = '8.2.0';

    /** @var string */
    protected $minimumJoomla = '5.0.0';

    /**
     * Releases before 0.6.3 shipped the dependencies as vendor.phar; an
     * upgrade removes it (autoload.php never reads it).
     *
     * @var list<string>
     */
    protected $deleteFiles = ['/plugins/hikashoppayment/openreceive/vendor.phar'];

    /** @var list<string> */
    private const SETTINGS = ['openreceive_nwc_uri', 'openreceive_lsc_uri_primary', 'openreceive_cron_at'];

    public function preflight($type, $parent)
    {
        if (!parent::preflight($type, $parent)) {
            return false;
        }
        if ($type === 'uninstall') {
            return true;
        }
        $missing = array_keys(array_filter([
            '64-bit PHP' => PHP_INT_SIZE < 8,
            'the gmp extension' => !extension_loaded('gmp'),
            'the sodium extension' => !extension_loaded('sodium'),
        ]));
        if ($missing !== []) {
            Factory::getApplication()->enqueueMessage('OpenReceive needs ' . implode(', ', $missing) . '. The web server\'s PHP and the command-line PHP both need them.', 'error');
            return false;
        }
        if (!is_file(JPATH_ADMINISTRATOR . '/components/com_hikashop/helpers/helper.php')) {
            Factory::getApplication()->enqueueMessage('OpenReceive is a HikaShop payment method: install HikaShop first (the free Starter edition is enough).', 'error');
            return false;
        }
        return true;
    }

    public function postflight($type, $parent)
    {
        if ($type === 'uninstall') {
            return true;
        }
        $db = Factory::getContainer()->get(DatabaseInterface::class);
        $query = $db->createQuery()
            ->update($db->quoteName('#__extensions'))
            ->set($db->quoteName('enabled') . ' = 1')
            ->where($db->quoteName('type') . ' = ' . $db->quote('plugin'))
            ->where($db->quoteName('element') . ' = ' . $db->quote('openreceive'))
            ->whereIn($db->quoteName('folder'), ['hikashoppayment', 'console'], \Joomla\Database\ParameterType::STRING);
        $db->setQuery($query)->execute();

        // On `php cli/joomla.php extension:install`, the console plugin already
        // required the previous release's autoload.php in this process, so
        // requiring it again does nothing: the new release's dependencies are
        // loaded by their own path first. Their loader goes ahead of the old one.
        $plugin = JPATH_PLUGINS . '/hikashoppayment/openreceive';
        if (is_file($plugin . '/vendor/autoload.php')) {
            require_once $plugin . '/vendor/autoload.php';
        }
        require_once $plugin . '/autoload.php';
        try {
            \OpenReceiveHikaShop\Runtime::migrate();
        } catch (\Throwable $error) {
            Factory::getApplication()->enqueueMessage('OpenReceive could not make its payment tables: ' . \OpenReceiveHikaShop\Runtime::errorMessage($error), 'error');
            return false;
        }
        // Last: the previous release's loader may still read its vendor.phar.
        $this->removeFiles();
        Factory::getApplication()->enqueueMessage('OpenReceive is installed. Next: HikaShop > System > Payment methods > New > OpenReceive, paste your receive-only NWC code and save; then add the cron line from https://openreceive.org/guides/quickstart-hikashop', 'message');
        return true;
    }

    public function uninstall($parent)
    {
        $db = Factory::getContainer()->get(DatabaseInterface::class);
        $query = $db->createQuery()
            ->delete($db->quoteName('#__hikashop_config'))
            ->whereIn($db->quoteName('config_namekey'), self::SETTINGS, \Joomla\Database\ParameterType::STRING);
        try {
            $db->setQuery($query)->execute();
        } catch (\Throwable) {
            // HikaShop was removed first: its configuration table went with it.
        }
        return true;
    }
}
