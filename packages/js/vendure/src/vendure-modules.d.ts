// The small part of Vendure and NestJS this package touches, declared here so
// the monorepo builds without installing Vendure. At runtime these modules
// are the Vendure application's own (peer dependencies), never a bundled copy.

declare module "@vendure/core" {
  export type ID = string | number;

  export interface CachedSession {
    readonly activeOrderId?: ID;
    readonly activeChannelId?: ID;
  }

  export class RequestContext {
    readonly apiType: string;
    readonly channelId: ID;
    readonly activeUserId: ID | undefined;
    readonly session: CachedSession | undefined;
  }

  export class Injector {
    get<T>(typeOrToken: unknown): T;
  }

  export class Channel {
    id: ID;
    code: string;
    token: string;
    defaultCurrencyCode: string;
    availableCurrencyCodes: string[];
  }

  export class Refund {
    state: string;
    total: number;
  }

  export class Payment {
    id: ID;
    method: string;
    state: string;
    amount: number;
    transactionId: string;
    refunds?: Refund[];
  }

  export class Customer {
    user?: { id: ID } | null;
  }

  export class Order {
    id: ID;
    code: string;
    state: string;
    active: boolean;
    currencyCode: string;
    totalWithTax: number;
    payments?: Payment[];
    customer?: Customer | null;
    channels?: Channel[];
  }

  export class PaymentMethod {
    id: ID;
    code: string;
    enabled: boolean;
    handler: { code: string };
  }

  export interface PaymentMetadata {
    [key: string]: unknown;
  }

  export interface Repository<T> {
    findOne(options: Record<string, unknown>): Promise<T | null>;
    find(options?: Record<string, unknown>): Promise<T[]>;
    createQueryBuilder(alias: string): {
      setLock(mode: "pessimistic_write"): ReturnType<Repository<T>["createQueryBuilder"]>;
      leftJoin(relation: string, alias: string): ReturnType<Repository<T>["createQueryBuilder"]>;
      where(
        where: string,
        parameters?: Record<string, unknown>,
      ): ReturnType<Repository<T>["createQueryBuilder"]>;
      andWhere(
        where: string,
        parameters?: Record<string, unknown>,
      ): ReturnType<Repository<T>["createQueryBuilder"]>;
      getOne(): Promise<T | null>;
      getMany(): Promise<T[]>;
    };
  }

  /** TypeORM's DataSource, as much of it as OpenReceive's adapter and the plugin use. */
  export interface DataSourceLike {
    readonly options: { readonly type: string };
    query(sql: string, params?: unknown[]): Promise<unknown>;
    transaction<T>(
      run: (manager: { query(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<T>,
    ): Promise<T>;
    getRepository<T>(entity: abstract new (...args: never[]) => T): Repository<T>;
  }

  export class TransactionalConnection {
    readonly rawConnection: DataSourceLike;
    withTransaction<T>(ctx: RequestContext, work: (ctx: RequestContext) => Promise<T>): Promise<T>;
    getRepository<T>(
      ctx: RequestContext,
      entity: abstract new (...args: never[]) => T,
    ): Repository<T>;
  }

  /** A Vendure error result, which services return in place of throwing. */
  export interface ErrorResult {
    readonly errorCode: string;
    readonly message: string;
    readonly transitionError?: string;
  }

  export class OrderService {
    findOne(ctx: RequestContext, orderId: ID, relations?: string[]): Promise<Order | undefined>;
    transitionToState(
      ctx: RequestContext,
      orderId: ID,
      state: string,
    ): Promise<Order | ErrorResult>;
    addPaymentToOrder(
      ctx: RequestContext,
      orderId: ID,
      input: { method: string; metadata: PaymentMetadata },
    ): Promise<Order | ErrorResult>;
  }

  export class PaymentMethodService {
    getEligiblePaymentMethods(
      ctx: RequestContext,
      order: Order,
    ): Promise<{ readonly id: ID; readonly code: string; readonly isEligible: boolean }[]>;
  }

  export class RequestContextService {
    create(config: {
      readonly apiType: "admin" | "shop";
      readonly channelOrToken?: string;
    }): Promise<RequestContext>;
  }

  export class ConfigService {
    readonly entityOptions: { readonly moneyStrategy?: { readonly precision?: number } };
    readonly apiOptions: { readonly cors?: unknown };
    readonly orderOptions: {
      readonly orderByCodeAccessStrategy?: {
        canAccessOrder(ctx: RequestContext, order: Order): boolean | Promise<boolean>;
      };
    };
  }

  export const Logger: {
    info(message: string, context?: string): void;
    warn(message: string, context?: string): void;
    error(message: string, context?: string): void;
  };

  export interface LocalizedString {
    readonly languageCode: string;
    readonly value: string;
  }

  export class PaymentMethodHandler {
    readonly code: string;
    constructor(config: {
      code: string;
      description: LocalizedString[];
      args: Record<string, never>;
      init?: (injector: Injector) => void | Promise<void>;
      createPayment: (
        ctx: RequestContext,
        order: Order,
        amount: number,
        args: Record<string, never>,
        metadata: PaymentMetadata,
      ) => Promise<{
        amount: number;
        state: "Settled";
        transactionId?: string;
        metadata?: PaymentMetadata;
      }>;
      settlePayment: () => { success: true } | Promise<{ success: true }>;
      cancelPayment?: () => { success: true } | Promise<{ success: true }>;
      createRefund?: (
        ctx: RequestContext,
        input: unknown,
        amount: number,
        order: Order,
        payment: Payment,
      ) => Promise<{ state: "Pending"; metadata?: PaymentMetadata }>;
    });
  }

  export class ScheduledTask {
    readonly id: string;
    constructor(config: {
      id: string;
      description?: string;
      schedule: string;
      execute: (args: { injector: Injector }) => Promise<unknown>;
    });
  }

  /** The parts of VendureConfig the plugin's configuration step changes. */
  export interface RuntimeVendureConfig {
    paymentOptions: { paymentMethodHandlers: PaymentMethodHandler[] };
    schedulerOptions: { tasks?: ScheduledTask[] };
    dbConnectionOptions: { migrations?: unknown };
  }

  export function VendurePlugin(metadata: {
    imports?: unknown[];
    controllers?: unknown[];
    compatibility?: string;
    configuration?: (
      config: RuntimeVendureConfig,
    ) => RuntimeVendureConfig | Promise<RuntimeVendureConfig>;
  }): ClassDecorator;

  export const PluginCommonModule: unknown;

  export function Ctx(): ParameterDecorator;
  export function Allow(...permissions: string[]): MethodDecorator;
  export const Permission: { readonly Public: string };
}

declare module "@nestjs/common" {
  export function Controller(prefix?: string): ClassDecorator;
  export function All(path?: string): MethodDecorator;
  export function Req(): ParameterDecorator;
  export function Res(): ParameterDecorator;
}
