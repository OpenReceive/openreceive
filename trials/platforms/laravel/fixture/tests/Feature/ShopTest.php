<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ShopTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_home_page_lists_the_products(): void
    {
        $this->get('/')->assertOk()->assertSee('Facet')->assertSee('Bezel');
    }

    public function test_a_buyer_sees_their_order_and_a_stranger_does_not(): void
    {
        $created = $this->post('/orders', ['product_id' => 1]);
        $created->assertRedirect();
        $orderPath = (string) parse_url($created->headers->get('Location'), PHP_URL_PATH);

        $this->get($orderPath)->assertOk()->assertSee('Facet');

        $this->flushSession();
        $this->get($orderPath)->assertStatus(404);
    }
}
