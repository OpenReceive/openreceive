<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Widget Shop</h1>
<ul>
	{#each data.products as product (product.id)}
		<li>
			{product.name} — ${product.price}
			<form method="post" action="/orders">
				<input type="hidden" name="product_id" value={product.id} />
				<button type="submit">Buy</button>
			</form>
		</li>
	{/each}
</ul>
