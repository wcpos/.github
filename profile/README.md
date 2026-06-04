# WooCommerce POS 👋

**A point of sale for WooCommerce.** WooCommerce POS lets store owners sell their WooCommerce products in person — same catalog, same stock, same customers — from a native app on a tablet, phone, desktop, or the web.

It connects directly to an existing WooCommerce store through the WooCommerce REST API. There's no separate product database and no middleware: your WooCommerce install stays the single source of truth. The client is offline-first, so the till keeps working even when the connection drops, and syncs back up when it returns.

🌐 [wcpos.com](https://wcpos.com) · 📖 [docs.wcpos.com](https://docs.wcpos.com)

## For developers

The product is open source and built from a few main pieces:

| Repository | What it is | Tech |
|---|---|---|
| [`woocommerce-pos`](https://github.com/wcpos/woocommerce-pos) | The free WordPress plugin. Extends the WooCommerce REST API for POS use and handles server-side order processing, tax, and gateways. | PHP |
| [`monorepo`](https://github.com/wcpos/monorepo) | The cross-platform client app (iOS, Android, web, desktop) with a local-first reactive database. | React Native · Expo · TypeScript · RxDB |
| [`electron`](https://github.com/wcpos/electron) | The desktop wrapper for the client app. | Electron |
| [`docs`](https://github.com/wcpos/docs) | User documentation, published to [docs.wcpos.com](https://docs.wcpos.com). | Docusaurus |

### Payment gateways & extensions

| Repository | What it is |
|---|---|
| [`stripe-terminal-for-woocommerce`](https://github.com/wcpos/stripe-terminal-for-woocommerce) | Stripe Terminal in-person payments |
| [`square-terminal-for-woocommerce`](https://github.com/wcpos/square-terminal-for-woocommerce) | Square Terminal in-person payments |
| [`sumup-terminal-for-woocommerce`](https://github.com/wcpos/sumup-terminal-for-woocommerce) | SumUp Terminal in-person payments |
| [`paypal-reader-for-woocommerce`](https://github.com/wcpos/paypal-reader-for-woocommerce) | PayPal Reader in-person payments |
| [`wcpos-vipps`](https://github.com/wcpos/wcpos-vipps) | Vipps MobilePay payment gateway |
| [`web-checkout-gateway`](https://github.com/wcpos/web-checkout-gateway) | Complete payments via the web store checkout |
| [`woocommerce-gateway-template`](https://github.com/wcpos/woocommerce-gateway-template) | Starter template for building your own custom gateway |

## Community & support

The best place to ask questions, report problems, or just say hi is our Discord.

[![Discord Chat](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Finvites%2FGCEeEVpEvX%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&logo=discord&logoColor=white&label=users%20online&color=green)](https://wcpos.com/discord)

You can also email [support@wcpos.com](mailto:support@wcpos.com).
