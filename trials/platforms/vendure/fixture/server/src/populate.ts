// Seeds the Widget Shop once: the United States, no tax, free shipping, the
// dummy "Standard Payment" method and the five widgets, as `@vendure/create`
// populates a new project. Runs before the server starts, on its own port.
import { bootstrap, JobQueueService, LanguageCode, Product, TransactionalConnection } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'path';
import { config } from './vendure-config';

const initialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Americas',
    taxRates: [{ name: 'Standard Tax', percentage: 0 }],
    shippingMethods: [{ name: 'Free shipping', price: 0 }],
    paymentMethods: [
        {
            name: 'Standard Payment',
            handler: {
                code: 'dummy-payment-handler',
                arguments: [{ name: 'automaticSettle', value: 'false' }],
            },
        },
    ],
    collections: [
        {
            name: 'Widgets',
            filters: [
                {
                    code: 'facet-value-filter',
                    args: { facetValueNames: ['Widgets'], containsAny: false },
                },
            ],
        },
    ],
    countries: [
        { name: 'United States', code: 'US', zone: 'Americas' },
        { name: 'Canada', code: 'CA', zone: 'Americas' },
    ],
};

async function main(): Promise<void> {
    const app = await bootstrap({
        ...config,
        apiOptions: { ...config.apiOptions, port: 3999 },
    });
    const products = await app.get(TransactionalConnection).rawConnection.getRepository(Product).count();
    if (products > 0) {
        console.log(`Already seeded: ${products} products.`);
        await app.close();
        return;
    }
    await app.get(JobQueueService).start();
    await populate(async () => app, initialData, path.join(__dirname, '../products.csv'));
    // The search index fills through the job queue: give it time to finish.
    await new Promise(resolve => setTimeout(resolve, 8000));
    await app.close();
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
