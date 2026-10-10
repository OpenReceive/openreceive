<?php

declare(strict_types=1);

const DB_PATH = "/data/shop.sqlite";
const CATALOG = [
    ["Facet", "7.00", "facet"],
    ["Bezel", "12.00", "bezel"],
    ["Hinge", "4.00", "hinge"],
    ["Latch", "9.00", "latch"],
    ["Knob", "3.00", "knob"],
];

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $pdo = new PDO("sqlite:" . DB_PATH);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec("PRAGMA journal_mode = WAL");
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            price TEXT NOT NULL,
            sku TEXT NOT NULL UNIQUE
        )"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        )"
    );
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY,
            user_id TEXT NOT NULL,
            product_name TEXT NOT NULL,
            amount TEXT NOT NULL,
            currency TEXT NOT NULL,
            status TEXT NOT NULL
        )"
    );
    $insert = $pdo->prepare(
        "INSERT INTO products (name, price, sku)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = ?)"
    );
    foreach (CATALOG as [$name, $price, $sku]) {
        $insert->execute([$name, $price, $sku, $sku]);
    }
    return $pdo;
}

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, "UTF-8");
}

function page(string $title, string $body): string
{
    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>"
        . h($title) . "</title></head><body><main><h1>" . h($title) . "</h1>"
        . $body . "</main></body></html>";
}

function userId(): ?string
{
    $value = $_COOKIE["widget_user"] ?? "";
    return $value === "" ? null : $value;
}

$path = parse_url($_SERVER["REQUEST_URI"] ?? "/", PHP_URL_PATH) ?: "/";
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";
db();

if ($path === "/health") {
    header("Content-Type: text/plain");
    echo "ok\n";
    return;
}

if ($path === "/" && $method === "GET") {
    $products = db()->query("SELECT id, name, price FROM products ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
    $items = "";
    foreach ($products as $product) {
        $items .= "<li>" . h($product["name"]) . " — $" . h($product["price"])
            . "<form method=\"post\" action=\"/orders\">"
            . "<input type=\"hidden\" name=\"product_id\" value=\"" . h((string) $product["id"]) . "\">"
            . "<button type=\"submit\">Buy</button></form></li>";
    }
    header("Content-Type: text/html; charset=utf-8");
    echo page("Widget Shop", "<ul>{$items}</ul>");
    return;
}

if ($path === "/orders" && $method === "POST") {
    $productId = (int) ($_POST["product_id"] ?? 0);
    $statement = db()->prepare("SELECT name, price FROM products WHERE id = ?");
    $statement->execute([$productId]);
    $product = $statement->fetch(PDO::FETCH_ASSOC);
    if ($product === false) {
        http_response_code(404);
        header("Content-Type: text/html; charset=utf-8");
        echo page("Not found", "<p>That product is not in the catalog.</p>");
        return;
    }
    $existing = userId();
    $known = false;
    if ($existing !== null) {
        $lookup = db()->prepare("SELECT id FROM users WHERE id = ?");
        $lookup->execute([$existing]);
        $known = $lookup->fetchColumn() !== false;
    }
    $current = $known ? $existing : bin2hex(random_bytes(16));
    if (!$known) {
        db()->prepare("INSERT INTO users (id, created_at) VALUES (?, datetime('now'))")->execute([$current]);
        setcookie("widget_user", $current, ["httponly" => true, "samesite" => "Lax", "path" => "/"]);
    }
    $insert = db()->prepare(
        "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES (?, ?, ?, 'USD', 'awaiting_payment')"
    );
    $insert->execute([$current, $product["name"], $product["price"]]);
    header("Location: /orders/" . db()->lastInsertId(), true, 303);
    return;
}

if (preg_match("#^/orders/(\d+)$#", $path, $match) === 1 && $method === "GET") {
    $statement = db()->prepare(
        "SELECT id, product_name, amount, currency FROM orders WHERE id = ? AND user_id = ?"
    );
    $statement->execute([(int) $match[1], userId()]);
    $order = $statement->fetch(PDO::FETCH_ASSOC);
    if ($order === false) {
        http_response_code(404);
        header("Content-Type: text/plain");
        echo "That order is not yours.\n";
        return;
    }
    header("Content-Type: text/html; charset=utf-8");
    echo page(
        "Order " . $order["id"],
        "<p>" . h($order["product_name"]) . " — $" . h($order["amount"]) . " " . h($order["currency"]) . "</p>"
        . "<p>Awaiting payment. Online payments are not set up yet.</p>"
    );
    return;
}

http_response_code(404);
header("Content-Type: text/plain");
echo "Not found\n";
