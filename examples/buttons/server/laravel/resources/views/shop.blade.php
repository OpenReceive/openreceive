<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Buy a Button — OpenReceive on Laravel</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    {{-- The token shared/client/http.ts reads. The OpenReceive routes sit inside
         this app's `web` group, so they need it too; Laravel's VerifyCsrfToken
         reads the X-CSRF-TOKEN header the checkout client sends from here. --}}
    <meta name="csrf-token" content="{{ csrf_token() }}">
    @viteReactRefresh
    @vite('resources/js/main.tsx')
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
