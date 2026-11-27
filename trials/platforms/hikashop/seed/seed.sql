-- What a HikaShop merchant has set up before the agent comes, on top of
-- HikaShop's setup assistant and its sample catalog (hikashop.ts runs both,
-- and makes the two Joomla customers with Joomla's console). Run once in the
-- shop's MariaDB, before the agent sees the shop; the agent does not.
--
-- The sample catalog's clothes weigh something, so HikaShop's checkout asks
-- for a shipping method: one free method, HikaShop's own "manual" plugin.
UPDATE joom_extensions SET enabled = 1 WHERE folder = 'hikashopshipping' AND element = 'manual';
INSERT INTO joom_hikashop_shipping
  (shipping_type, shipping_zone_namekey, shipping_price, shipping_currency_id, shipping_name,
   shipping_alias, shipping_description, shipping_published, shipping_currency, shipping_params)
SELECT 'manual', '', 0, currency_id, 'Free shipping', '', '', 1, '', 'O:8:"stdClass":0:{}'
FROM joom_hikashop_currency WHERE currency_code = 'USD';

-- Each customer has a billing and a shipping address, so checkout goes
-- straight to the shipping and payment choices.
INSERT INTO joom_hikashop_address
  (address_user_id, address_type, address_title, address_firstname, address_lastname,
   address_street, address_post_code, address_city, address_telephone, address_state,
   address_country, address_published, address_default)
SELECT u.user_id, t.address_type, 'Mr', c.firstname, c.lastname, '1 Widget Street', '10001',
  'New York', '5555550100', 'state_New_York_4296', 'country_United_States_of_America_223', 1, 1
FROM joom_hikashop_user u
JOIN (
  SELECT 'info@openreceive.org' AS email, 'OpenReceive' AS firstname, 'Checkout Test' AS lastname
  UNION ALL SELECT 'stranger@example.test', 'Other', 'Customer'
) c ON c.email = u.user_email
CROSS JOIN (SELECT 'billing' AS address_type UNION ALL SELECT 'shipping') t;

-- The two garments the live checks and the payer walk buy (hikashop.ts),
-- kept in stock in every size and colour, so a walk's many orders never sell
-- one out.
UPDATE joom_hikashop_product SET product_quantity = -1
WHERE product_code IN ('SAMPLE-0004', 'SAMPLE-0005')
   OR product_parent_id IN (
     SELECT product_id FROM (
       SELECT product_id FROM joom_hikashop_product WHERE product_code IN ('SAMPLE-0004', 'SAMPLE-0005')
     ) AS bought
   );

-- Joomla's usage statistics and guided tours are for the site's owner in
-- its back office; neither belongs in a throwaway shop.
UPDATE joom_extensions SET enabled = 0 WHERE folder = 'system' AND element IN ('stats', 'guidedtours');
