<script lang="ts">
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<title>Widget Shop</title>
</svelte:head>

<main>
	{@render children()}
</main>
