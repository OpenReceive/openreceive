<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Order extends Model
{
    protected $fillable = ['customer_token', 'product_name', 'amount', 'currency', 'status'];
}
