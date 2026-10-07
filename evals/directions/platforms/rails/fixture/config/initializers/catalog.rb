connection = ActiveRecord::Base.connection
connection.execute <<~SQL
  CREATE TABLE IF NOT EXISTS products (
    id integer PRIMARY KEY AUTOINCREMENT,
    name text NOT NULL,
    price text NOT NULL,
    sku text NOT NULL UNIQUE
  );
SQL
connection.execute <<~SQL
  CREATE TABLE IF NOT EXISTS users (
    id integer PRIMARY KEY AUTOINCREMENT,
    created_at datetime NOT NULL
  );
SQL
connection.execute <<~SQL
  CREATE TABLE IF NOT EXISTS orders (
    id integer PRIMARY KEY AUTOINCREMENT,
    user_id integer NOT NULL,
    product_name text NOT NULL,
    amount text NOT NULL,
    currency text NOT NULL,
    status text NOT NULL
  );
SQL

[
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
].each do |name, price, sku|
  next if connection.select_value("SELECT id FROM products WHERE sku = #{connection.quote(sku)}")

  connection.execute(
    "INSERT INTO products (name, price, sku) VALUES (#{connection.quote(name)}, #{connection.quote(price)}, #{connection.quote(sku)})",
  )
end
