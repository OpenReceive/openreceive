<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let order = $derived(data.order);
</script>

<svelte:head>
	<title>Order {order.id}</title>
</svelte:head>

<h1>Order {order.id}</h1>
<p>{order.product_name} — ${order.amount} {order.currency}</p>
{#if order.status === 'paid'}
	<p>Paid.</p>
{:else}
	<p>Awaiting payment. Online payments are not set up yet.</p>
{/if}
