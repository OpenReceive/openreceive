// Shakapacker's CSS rule runs postcss-loader unconditionally, and it wants a
// config to exist. There are no plugins: @mantine/core ships prebuilt CSS and
// shared/client/shop.css is plain CSS with five custom properties.
module.exports = {
  plugins: [],
};
