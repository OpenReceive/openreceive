<?php

// The file store needs no table. OpenReceive uses it for one thing: the
// wallet's info event, remembered across requests so a checkout call costs
// one relay round trip instead of two (openreceive.wallet_info_cache_seconds).
return [
    'default' => env('CACHE_STORE', 'file'),
];
