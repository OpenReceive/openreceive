{{-- Livewire loads these once per page, in the order written. The scripts
     come first: Livewire walks these tags while it moves each stylesheet into
     the page, which skips the tag right after a stylesheet. A script is
     copied, not moved, so the stylesheet after the scripts still loads. --}}
@assets
<script type="module" src="{{ $script }}"></script>
<script>
    // The payment is already recorded on the invoice when the checkout reports
    // it settled. The event does not bubble; a capturing listener still sees it.
    document.addEventListener('openreceive-settled', (event) => {
        const url = event.target?.dataset?.returnUrl;
        if (url) window.location.assign(url);
    }, true);
</script>
<link rel="stylesheet" href="{{ $style }}">
@endassets

{{-- wire:ignore: the invoice page re-renders while it waits, and must leave the live checkout alone. --}}
<div wire:ignore class="mt-2">
    <openreceive-checkout
        reference="{{ $invoice->id }}"
        prefix="{{ $prefix }}"
        resumable="true"
        data-return-url="{{ $returnUrl }}"
    ></openreceive-checkout>
</div>
