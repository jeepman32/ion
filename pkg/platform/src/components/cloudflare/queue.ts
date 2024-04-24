import { ComponentResourceOptions, Output, all, output } from "@pulumi/pulumi";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import type { Input } from "../input";
import { Worker, WorkerArgs } from "./worker";
import { VisibleError } from "../error";
import { hashStringToPrettyString, sanitizeToPascalCase } from "../naming";
import * as cf from "@pulumi/cloudflare";

export interface QueueArgs {
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the SQS queue resource.
     */
    queue?: Transform<cf.QueueArgs>;
  };
}

export interface QueueSubscriber {
  /**
   * The Lambda function that'll be notified.
   */
  function: Output<Worker>;
}

/**
 * The `Queue` component lets you add a serverless queue to your app. It uses [Amazon SQS](https://aws.amazon.com/sqs/).
 *
 * @example
 *
 * #### Create a queue
 *
 * ```ts
 * const queue = new sst.aws.Queue("MyQueue");
 * ```
 *
 * #### Make it a FIFO queue
 *
 * You can optionally make it a FIFO queue.
 *
 * ```ts {2}
 * new sst.aws.Queue("MyQueue", {
 *   fifo: true
 * });
 * ```
 *
 * #### Add a subscriber
 *
 * ```ts
 * queue.subscribe("src/subscriber.handler");
 * ```
 *
 * #### Link the queue to a resource
 *
 * You can link the queue to other resources, like a function or your Next.js app.
 *
 * ```ts
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [queue]
 * });
 * ```
 *
 * Once linked, you can send messages to the queue from your function code.
 *
 * ```ts title="app/page.tsx" {1,7}
 * import { Resource } from "sst";
 * import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
 *
 * const sqs = new SQSClient({});
 *
 * await sqs.send(new SendMessageCommand({
 *   QueueUrl: Resource.MyQueue.url,
 *   MessageBody: "Hello from Next.js!"
 * }));
 * ```
 */
export class Queue extends Component implements Link.Cloudflare.Linkable {
  private constructorName: string;
  private queue: cf.Queue;
  private isSubscribed: boolean = false;

  constructor(name: string, args?: QueueArgs, opts?: ComponentResourceOptions) {
    super(__pulumiType, name, args, opts);

    const parent = this;

    const queue = createQueue();

    this.constructorName = name;
    this.queue = queue;

    function createQueue() {
      return new cf.Queue(
        `${name}Queue`,
        {
          name,
          accountId: sst.cloudflare.DEFAULT_ACCOUNT_ID,
        },
        { parent },
      );
    }
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The Cloudflare Queue.
       */
      queue: this.queue,
    };
  }

  /**
   * Subscribe to this queue.
   *
   * @param subscriber The function that'll be notified.
   * @param args Configure the subscription.
   *
   * @example
   *
   * ```js
   * queue.subscribe("src/subscriber.handler");
   *
   * Add a filter to the subscription.
   *
   * ```js
   * queue.subscribe("src/subscriber.handler", {
   *   filters: [
   *     {
   *       body: {
   *         RequestCode: ["BBBB"]
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js
   * queue.subscribe({
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   */
  public subscribe(subscriber: WorkerArgs) {
    if (this.isSubscribed)
      throw new VisibleError(
        `Cannot subscribe to the "${this.constructorName}" queue multiple times. A Cloudflare Queue can only have one consumer.`,
      );
    this.isSubscribed = true;

    return Queue._subscribeFunction(this.constructorName, subscriber);
  }

  /**
   * Subscribe to an SQS queue that was not created in your app.
   *
   * @param queueArn The ARN of the SQS queue to subscribe to.
   * @param subscriber The function that'll be notified.
   * @param args Configure the subscription.
   *
   * @example
   *
   * For example, let's say you have an existing SQS queue with the following ARN.
   *
   * ```js
   * const queueArn = "arn:aws:sqs:us-east-1:123456789012:MyQueue";
   * ```
   *
   * You can subscribe to it by passing in the ARN.
   *
   * ```js
   * sst.aws.Queue.subscribe(queueArn, "src/subscriber.handler");
   * ```
   *
   * Add a filter to the subscription.
   *
   * ```js
   * sst.aws.Queue.subscribe(queueArn, "src/subscriber.handler", {
   *   filters: [
   *     {
   *       body: {
   *         RequestCode: ["BBBB"]
   *       }
   *     }
   *   ]
   * });
   * ```
   *
   * Customize the subscriber function.
   *
   * ```js
   * sst.aws.Queue.subscribe(queueArn, {
   *   handler: "src/subscriber.handler",
   *   timeout: "60 seconds"
   * });
   * ```
   */
  public static subscribe(queueName: Input<string>, subscriber: WorkerArgs) {
    return this._subscribeFunction(queueName, subscriber);
  }

  private static _subscribeFunction(
    name: Input<string>,
    subscriber: WorkerArgs,
  ): QueueSubscriber {
    const ret = all([name]).apply(([name]) => {
      // Build subscriber name
      const namePrefix = sanitizeToPascalCase(name);
      const id = sanitizeToPascalCase(hashStringToPrettyString(name, 4));

      const fn = new Worker(`${namePrefix}Subscriber${id}`, subscriber);

      return { fn };
    });

    return {
      function: ret.fn,
    };
  }

  public getCloudflareBinding(): Link.Cloudflare.Binding {
    return {
      type: "queueBindings",
      properties: {
        queue: this.queue.id,
      },
    };
  }
}

const __pulumiType = "sst:cf:Queue";
// @ts-expect-error
Queue.__pulumiType = __pulumiType;
