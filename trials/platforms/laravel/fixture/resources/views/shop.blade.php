<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Widget Shop</title>
</head>
<body>
  <main>
    <h1>Widget Shop</h1>
    <ul>
      @foreach ($products as $product)
        <li>
          {{ $product->name }} — ${{ $product->price }}
          <form method="post" action="/orders">
            @csrf
            <input type="hidden" name="product_id" value="{{ $product->id }}">
            <button type="submit">Buy</button>
          </form>
        </li>
      @endforeach
    </ul>
  </main>
</body>
</html>
