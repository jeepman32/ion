import { ComponentResourceOptions, Output, all, output } from "@pulumi/pulumi";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import type { Input } from "../input";
import { Worker, WorkerArgs } from "./worker";
import { VisibleError } from "../error";
import { hashStringToPrettyString, sanitizeToPascalCase } from "../naming";
import * as cf from "@pulumi/cloudflare";

export interface RulesetArgs {
  /**
   * [Transform](/docs/components#transform) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the SQS queue resource.
     */
    queue?: Transform<cf.RulesetArgs>;
  };
}

export interface RulesetSubscriber {
  /**
   * The Lambda function that'll be notified.
   */
  function: Output<Worker>;
}

/**
 * The `Ruleset` component lets you add a serverless queue to your app. It uses [Amazon SQS](https://aws.amazon.com/sqs/).
 *
 * @example
 *
 * #### Create a queue
 *
 * ```ts
 * const queue = new sst.aws.Ruleset("MyRuleset");
 * ```
 *
 * #### Make it a FIFO queue
 *
 * You can optionally make it a FIFO queue.
 *
 * ```ts {2}
 * new sst.aws.Ruleset("MyRuleset", {
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
 *   RulesetUrl: Resource.MyRuleset.url,
 *   MessageBody: "Hello from Next.js!"
 * }));
 * ```
 */
export class Ruleset extends Component implements Link.Cloudflare.Linkable {
  private constructorName: string;
  private ruleset: cf.Ruleset;

  constructor(
    name: string,
    args?: RulesetArgs,
    opts?: ComponentResourceOptions,
  ) {
    super(__pulumiType, name, args, opts);

    const parent = this;

    const ruleset = createRuleset();

    this.constructorName = name;
    this.ruleset = ruleset;

    function createRuleset() {
      return new cf.Ruleset(
        `${name}Ruleset`,
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
       * The Cloudflare Ruleset.
       */
      queue: this.ruleset,
    };
  }

  public getCloudflareBinding(): Link.Cloudflare.Binding {
    return {
      type: "rulesetBindings",
      properties: {
        queue: this.ruleset.id,
      },
    };
  }
}

const __pulumiType = "sst:cf:Ruleset";
// @ts-expect-error
Ruleset.__pulumiType = __pulumiType;
