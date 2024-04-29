import fs from "fs";
import path from "path";
import { globSync } from "glob";
import { ComponentResourceOptions, Output, all } from "@pulumi/pulumi";
import { Worker } from "./worker.js";
import {
  Plan,
  SsrSiteArgs,
  createCacheRuleset,
  createKvStorage,
  createRouter,
  prepare,
  validatePlan,
} from "./ssr-site.js";
import { Component } from "../component.js";
import { Link } from "../link.js";
import { VisibleError } from "../error.js";
import type { Input } from "../input.js";
import { Cache } from "./providers/cache.js";
import { Queue } from "./queue.js";
import { buildApp } from "../base/base-ssr-site.js";
import { pathToRegexp } from "path-to-regexp";
import { Kv } from "./kv.js";

const DEFAULT_OPEN_NEXT_VERSION = "3.0.0-rc.11";
const DEFAULT_CACHE_POLICY_ALLOWED_HEADERS = [
  "accept",
  "x-prerender-revalidate",
  "x-prerender-bypass",
  "rsc",
  "next-router-prefetch",
  "next-router-state-tree",
  "next-url",
];

type BaseFunction = {
  handler: string;
  bundle: string;
};

type OpenNextFunctionOrigin = {
  type: "function";
  streaming?: boolean;
  wrapper: string;
  converter: string;
} & BaseFunction;

type OpenNextServerFunctionOrigin = OpenNextFunctionOrigin & {
  queue: string;
  incrementalCache: string;
  tagCache: string;
};

type OpenNextImageOptimizationOrigin = OpenNextFunctionOrigin & {
  imageLoader: string;
};

type OpenNextS3Origin = {
  type: "s3";
  originPath: string;
  copy: {
    from: string;
    to: string;
    cached: boolean;
    versionedSubDir?: string;
  }[];
};

interface OpenNextOutput {
  edgeFunctions: {
    [key: string]: BaseFunction;
  } & {
    middleware?: BaseFunction & { pathResolver: string };
  };
  origins: {
    s3: OpenNextS3Origin;
    default: OpenNextServerFunctionOrigin;
    imageOptimizer: OpenNextImageOptimizationOrigin;
  } & {
    [key: string]: OpenNextServerFunctionOrigin | OpenNextS3Origin;
  };
  behaviors: {
    pattern: string;
    origin?: string;
    edgeFunction?: string;
  }[];
  additionalProps?: {
    disableIncrementalCache?: boolean;
    disableTagCache?: boolean;
    initializationFunction?: BaseFunction;
    warmer?: BaseFunction;
    revalidationFunction?: BaseFunction;
  };
}

export interface NextjsArgs extends SsrSiteArgs {
  /**
   * The number of instances of the [server function](#nodes-server) to keep warm. This is useful for cases where you are experiencing long cold starts. The default is to not keep any instances warm.
   *
   * This works by starting a serverless cron job to make _n_ concurrent requests to the server function every few minutes. Where _n_ is the number of instances to keep warm.
   *
   * @default `0`
   */
  // warm?: SsrSiteArgs["warm"];
  /**
   * Path to the directory where your Next.js app is located. This path is relative to your `sst.config.ts`.
   *
   * By default this assumes your Next.js app is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Next.js app is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: SsrSiteArgs["path"];
  /**
   * [Link resources](/docs/linking/) to your Next.js app. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access it in your site using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of resources to link to the function.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: SsrSiteArgs["link"];
  /**
   * Configure how the CloudFront cache invalidations are handled. This is run after your Next.js app has been deployed.
   * :::tip
   * You get 1000 free invalidations per month. After that you pay $0.005 per invalidation path. [Read more here](https://aws.amazon.com/cloudfront/pricing/).
   * :::
   * @default `&lcub;paths: "all", wait: false&rcub;`
   * @example
   * Turn off invalidations.
   * ```js
   * {
   *   invalidation: false
   * }
   * ```
   * Wait for all paths to be invalidated.
   * ```js
   * {
   *   invalidation: {
   *     paths: "all",
   *     wait: true
   *   }
   * }
   * ```
   */
  // invalidation?: SsrSiteArgs["invalidation"];
  /**
   * The command used internally to build your Next.js app. It uses OpenNext with the `openNextVersion`.
   *
   * @default `"npx --yes open-next@OPEN_NEXT_VERSION build"`
   *
   * @example
   *
   * If you want to use a custom `build` script from your `package.json`.
   * ```js
   * {
   *   buildCommand: "npm run build"
   * }
   * ```
   */
  buildCommand?: SsrSiteArgs["buildCommand"];
  /**
   * Set [environment variables](https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables) in your Next.js app. These are made available:
   *
   * 1. In `next build`, they are loaded into `process.env`.
   * 2. Locally while running `sst dev next dev`.
   *
   * :::tip
   * You can also `link` resources to your Next.js app and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * Recall that in Next.js, you need to prefix your environment variables with `NEXT_PUBLIC_` to access these in the browser. [Read more here](https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser).
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     // Accessible in the browser
   *     NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: SsrSiteArgs["environment"];
  /**
   * Set a custom domain for your Next.js app. Supports domains hosted either on
   * [Route 53](https://aws.amazon.com/route53/) or outside AWS.
   *
   * :::tip
   * You can also migrate an externally hosted domain to Amazon Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   * :::
   *
   * @example
   *
   * ```js
   * {
   *   domain: "domain.com"
   * }
   * ```
   *
   * Specify the Route 53 hosted zone and a `www.` version of the custom domain.
   *
   * ```js
   * {
   *   domain: {
   *     domainName: "domain.com",
   *     hostedZone: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: SsrSiteArgs["domain"];
  /**
   * Configure how the Next.js app assets are uploaded to S3.
   *
   * By default, this is set to the following. Read more about these options below.
   * ```js
   * {
   *   assets: {
   *     textEncoding: "utf-8",
   *     versionedFilesCacheHeader: "public,max-age=31536000,immutable",
   *     nonVersionedFilesCacheHeader: "public,max-age=0,s-maxage=86400,stale-while-revalidate=8640"
   *   }
   * }
   * ```
   * Read more about these options below.
   * @default `Object`
   */
  assets?: SsrSiteArgs["assets"];
  /**
   * Configure the [OpenNext](https://open-next.js.org) version used to build the Next.js app.
   *
   * :::note
   * This does not automatically update to the latest OpenNext version. It remains pinned to the version of SST you have.
   * :::
   *
   * By default, this is pinned to the version of OpenNext that was released with the SST version you are using. You can [find this in the source](https://github.com/sst/ion/blob/dev/pkg/platform/src/components/aws/nextjs.ts) under `DEFAULT_OPEN_NEXT_VERSION`.
   *
   * @default The latest version of OpenNext
   * @example
   * ```js
   * {
   *   openNextVersion: "3.0.0-rc.3"
   * }
   * ```
   */
  openNextVersion?: Input<string>;
}

/**
 * The `Nextjs` component lets you deploy [Next.js](https://nextjs.org) apps on AWS. It uses
 * [OpenNext](https://open-next.js.org) to build your Next.js app, and transforms the build
 * output to a format that can be deployed to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Next.js app that's in the project root.
 *
 * ```js
 * new sst.aws.Nextjs("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys a Next.js app in the `my-next-app/` directory.
 *
 * ```js {2}
 * new sst.aws.Nextjs("MyWeb", {
 *   path: "my-next-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Next.js app.
 *
 * ```js {2}
 * new sst.aws.Nextjs("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4}
 * new sst.aws.Nextjs("MyWeb", {
 *   domain: {
 *     domainName: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Next.js app. This will grant permissions
 * to the resources and allow you to access it in your app.
 *
 * ```ts {4}
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Nextjs("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Next.js app.
 *
 * ```ts title="app/page.tsx"
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ```
 */
export class Nextjs extends Component implements Link.Linkable {
  private assets: Kv;
  private router: Output<Worker>;
  private server: Output<Worker>;

  constructor(
    name: string,
    args: NextjsArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    const parent = this;
    const buildCommand = normalizeBuildCommand();
    const { sitePath } = prepare(args);
    const outputPath = buildApp(name, args, sitePath, buildCommand);
    const { openNextOutput, buildId, prerenderManifest } = loadBuildOutput();

    // const revalidationQueue = createRevalidationQueue();
    // const revalidationTable = createRevalidationTable();
    // createRevalidationTableSeeder();

    const plan = buildPlan();
    const storage = createKvStorage(parent, name, args);
    const { router, server } = createRouter(
      parent,
      name,
      args,
      outputPath,
      storage,
      plan,
    );

    removeSourcemaps();
    handleMissingSourcemap();
    // createCacheRuleset(
    //   name,
    //   "SST NextJS Cache Bypass",
    //   DEFAULT_CACHE_POLICY_ALLOWED_HEADERS,
    //   parent,
    // );

    this.assets = storage;
    this.router = router;
    this.server = server;
    // this.registerOutputs({
    //   _hint: $dev
    //     ? undefined
    //     : all([this.cdn.domainUrl, this.cdn.url]).apply(
    //         ([domainUrl, url]) => domainUrl ?? url,
    //       ),
    //   _metadata: {
    //     mode: $dev ? "placeholder" : "deployed",
    //     path: sitePath,
    //     url: distribution.apply((d) => d.domainUrl ?? d.url),
    //     edge: plan.edge,
    //     server: serverFunction.arn,
    //   },
    // });

    function buildPlan() {
      return all([openNextOutput]).apply(([openNextOutput]) => {
        return validatePlan({
          assets: Object.entries(openNextOutput.origins).reduce(
            ({ copy }, [key, value]) => {
              if (key === "s3") {
                if (value.type === "function") {
                  throw new Error(
                    `Open next has generated an S3 function, which is currently not implemented for Cloudflare.`,
                  );
                }

                if (value.type === "s3") {
                  copy.push(...value.copy);
                }
              }

              return { copy };
            },
            { copy: [] } as Parameters<typeof validatePlan>[0]["assets"],
          ),
          routes: openNextOutput.behaviors.reduce(
            (routes, { pattern, origin: buildOrigin }) => {
              let origin: "assets" | "server";

              // Switch through the routes we've been given by OpenNext and convert them to Cloudflare routes.
              switch (buildOrigin) {
                case "imageOptimizer":
                case "default":
                  origin = "server";
                  break;
                case "s3":
                  origin = "assets";
                  break;
                // Not sure if this is possible, but Typescript insists that it might be, so error on default.
                default:
                  throw new Error(
                    `We can't convert ${buildOrigin} from open-next.output.json => behaviours.origin`,
                  );
              }

              // path-to-regex doesn't support wildcards. It does support the same behaviour with :splat*.
              const convertedPattern = pattern.replaceAll("*", ":splat*");

              routes.push({
                regex: pathToRegexp(convertedPattern).source,
                origin,
              });
              return routes;
            },
            [] as Parameters<typeof validatePlan>[0]["routes"],
          ),
          server: {
            ...openNextOutput.origins.default,
            handler: path.join(
              $cli.paths.root,
              openNextOutput.origins.default.bundle,
              "index.mjs",
            ),
          },
        }) as Plan;
      });
    }

    function normalizeBuildCommand() {
      return all([args?.buildCommand, args?.openNextVersion]).apply(
        ([buildCommand, openNextVersion]) =>
          buildCommand ??
          [
            "npx",
            "--yes",
            `open-next@${openNextVersion ?? DEFAULT_OPEN_NEXT_VERSION}`,
            "build",
          ].join(" "),
      );
    }

    function loadBuildOutput() {
      const cache = new Cache(
        `${name}OpenNextOutput`,
        {
          data: $dev ? loadOpenNextOutputPlaceholder() : loadOpenNextOutput(),
        },
        {
          parent,
          ignoreChanges: $dev ? ["*"] : undefined,
        },
      );

      return {
        openNextOutput: cache.data as ReturnType<typeof loadOpenNextOutput>,
        buildId: loadBuildId(),
        routesManifest: loadRoutesManifest(),
        appPathRoutesManifest: loadAppPathRoutesManifest(),
        appPathsManifest: loadAppPathsManifest(),
        pagesManifest: loadPagesManifest(),
        prerenderManifest: loadPrerenderManifest(),
      };
    }

    function loadOpenNextOutput() {
      return outputPath.apply((outputPath) => {
        const openNextOutputPath = path.join(
          outputPath,
          ".open-next",
          "open-next.output.json",
        );
        if (!fs.existsSync(openNextOutputPath)) {
          throw new VisibleError(
            `Failed to load open-next.output.json from "${openNextOutputPath}".`,
          );
        }
        const content = fs.readFileSync(openNextOutputPath).toString();
        const json = JSON.parse(content) as OpenNextOutput;
        // Currently open-next.output.json's initializationFunction value
        // is wrong, it is set to ".open-next/initialization-function"
        if (json.additionalProps?.initializationFunction) {
          json.additionalProps.initializationFunction = {
            handler: "index.handler",
            bundle: ".open-next/dynamodb-provider",
          };
        }
        return json;
      });
    }

    function loadOpenNextOutputPlaceholder() {
      // Configure origins and behaviors based on the Next.js app from quick start
      return outputPath.apply((outputPath) => ({
        edgeFunctions: {},
        origins: {
          s3: {
            type: "s3",
            originPath: "_assets",
            // do not upload anything
            copy: [],
          },
          imageOptimizer: {
            type: "function",
            handler: "index.handler",
            bundle: path.join(
              outputPath,
              ".open-next/image-optimization-function",
            ),
            streaming: false,
          },
          default: {
            type: "function",
            handler: "index.handler",
            bundle: path.join(
              outputPath,
              ".open-next/server-functions/default",
            ),
            streaming: false,
          },
        },
        behaviors: [
          { pattern: "_next/image*", origin: "imageOptimizer" },
          { pattern: "_next/data/*", origin: "default" },
          { pattern: "*", origin: "default" },
          { pattern: "BUILD_ID", origin: "s3" },
          { pattern: "_next/*", origin: "s3" },
          { pattern: "favicon.ico", origin: "s3" },
          { pattern: "next.svg", origin: "s3" },
          { pattern: "vercel.svg", origin: "s3" },
        ],
        additionalProps: {
          // skip creating revalidation queue
          disableIncrementalCache: true,
          // skip creating revalidation table
          disableTagCache: true,
        },
      }));
    }

    function loadBuildId() {
      return outputPath.apply((outputPath) => {
        if ($dev) return "mock-build-id";

        try {
          return fs
            .readFileSync(path.join(outputPath, ".next/BUILD_ID"))
            .toString();
        } catch (e) {
          console.error(e);
          throw new VisibleError(
            `Failed to read build id from ".next/BUILD_ID" for the "${name}" site.`,
          );
        }
      });
    }

    function loadRoutesManifest() {
      return outputPath.apply((outputPath) => {
        if ($dev) return { dynamicRoutes: [], staticRoutes: [] };

        try {
          const content = fs
            .readFileSync(path.join(outputPath, ".next/routes-manifest.json"))
            .toString();
          return JSON.parse(content) as {
            dynamicRoutes: { page: string; regex: string }[];
            staticRoutes: { page: string; regex: string }[];
            dataRoutes?: { page: string; dataRouteRegex: string }[];
          };
        } catch (e) {
          console.error(e);
          throw new VisibleError(
            `Failed to read routes data from ".next/routes-manifest.json" for the "${name}" site.`,
          );
        }
      });
    }

    function loadAppPathRoutesManifest() {
      // Example
      // {
      //   "/_not-found": "/_not-found",
      //   "/page": "/",
      //   "/favicon.ico/route": "/favicon.ico",
      //   "/api/route": "/api",                    <- app/api/route.js
      //   "/api/sub/route": "/api/sub",            <- app/api/sub/route.js
      //   "/items/[slug]/route": "/items/[slug]"   <- app/items/[slug]/route.js
      // }

      return outputPath.apply((outputPath) => {
        if ($dev) return {};

        try {
          const content = fs
            .readFileSync(
              path.join(outputPath, ".next/app-path-routes-manifest.json"),
            )
            .toString();
          return JSON.parse(content) as Record<string, string>;
        } catch (e) {
          return {};
        }
      });
    }

    function loadAppPathsManifest() {
      return outputPath.apply((outputPath) => {
        if ($dev) return {};

        try {
          const content = fs
            .readFileSync(
              path.join(outputPath, ".next/server/app-paths-manifest.json"),
            )
            .toString();
          return JSON.parse(content) as Record<string, string>;
        } catch (e) {
          return {};
        }
      });
    }

    function loadPagesManifest() {
      return outputPath.apply((outputPath) => {
        if ($dev) return {};

        try {
          const content = fs
            .readFileSync(
              path.join(outputPath, ".next/server/pages-manifest.json"),
            )
            .toString();
          return JSON.parse(content) as Record<string, string>;
        } catch (e) {
          return {};
        }
      });
    }

    function loadPrerenderManifest() {
      return outputPath.apply((outputPath) => {
        if ($dev) return { version: 0, routes: {} };

        try {
          const content = fs
            .readFileSync(
              path.join(outputPath, ".next/prerender-manifest.json"),
            )
            .toString();
          return JSON.parse(content) as {
            version: number;
            routes: Record<string, unknown>;
          };
        } catch (e) {
          console.debug("Failed to load prerender-manifest.json", e);
        }
      });
    }

    // TODO: This depends on how the Cloudflare implementation (or more generic implementation) of OpenNext revalidation works.
    // Currently, OpenNext seem to have chosen FIFO queues on SQS as they include content-based de-duping, which means that sites
    // with high volumes won't generate hundreds of requests to revalidate a page. This may be implemented on CF with KV usage instead,
    // or with a more OpenNext specific solution. Or even some sort of tag in the generated file that could be checked first, before trying again.
    // function createRevalidationQueue() {
    //   return all([outputPath, openNextOutput]).apply(
    //     ([outputPath, openNextOutput]) => {
    //       if (openNextOutput.additionalProps?.disableIncrementalCache) return;

    //       const revalidationFunction =
    //         openNextOutput.additionalProps?.revalidationFunction;
    //       if (!revalidationFunction) return;

    //       const queue = new Queue(
    //         `${name}RevalidationQueue`,
    //         {
    //           transform: {
    //             queue: (args) => {
    //               args.receiveWaitTimeSeconds = 20;
    //             },
    //           },
    //         },
    //         { parent },
    //       );
    //       queue.subscribe(
    //         {
    //           description: `${name} ISR revalidator`,
    //           handler: revalidationFunction.handler,
    //           bundle: path.join(outputPath, revalidationFunction.bundle),
    //           runtime: "nodejs20.x",
    //           timeout: "30 seconds",
    //           permissions: [
    //             {
    //               actions: [
    //                 "sqs:ChangeMessageVisibility",
    //                 "sqs:DeleteMessage",
    //                 "sqs:GetQueueAttributes",
    //                 "sqs:GetQueueUrl",
    //                 "sqs:ReceiveMessage",
    //               ],
    //               resources: [queue.arn],
    //             },
    //           ],
    //           live: false,
    //           _ignoreCodeChanges: $dev,
    //         },
    //         {
    //           transform: {
    //             eventSourceMapping: (args) => {
    //               args.batchSize = 5;
    //             },
    //           },
    //         },
    //       );
    //       return queue;
    //     },
    //   );
    // }

    // function createRevalidationTable() {
    //   return openNextOutput.apply((openNextOutput) => {
    //     if (openNextOutput.additionalProps?.disableTagCache) return;

    //     return new pulumiAws.dynamodb.Table(
    //       `${name}RevalidationTable`,
    //       {
    //         attributes: [
    //           { name: "tag", type: "S" },
    //           { name: "path", type: "S" },
    //           { name: "revalidatedAt", type: "N" },
    //         ],
    //         hashKey: "tag",
    //         rangeKey: "path",
    //         pointInTimeRecovery: {
    //           enabled: true,
    //         },
    //         billingMode: "PAY_PER_REQUEST",
    //         globalSecondaryIndexes: [
    //           {
    //             name: "revalidate",
    //             hashKey: "path",
    //             rangeKey: "revalidatedAt",
    //             projectionType: "ALL",
    //           },
    //         ],
    //       },
    //       { parent },
    //     );
    //   });
    // }

    // function createRevalidationTableSeeder() {
    //   return all([
    //     revalidationTable,
    //     outputPath,
    //     openNextOutput,
    //     prerenderManifest,
    //   ]).apply(
    //     ([
    //       revalidationTable,
    //       outputPath,
    //       openNextOutput,
    //       prerenderManifest,
    //     ]) => {
    //       if (openNextOutput.additionalProps?.disableTagCache) return;
    //       if (!openNextOutput.additionalProps?.initializationFunction) return;

    //       // Provision 128MB of memory for every 4,000 prerendered routes,
    //       // 1GB per 40,000, up to 10GB. This tends to use ~70% of the memory
    //       // provisioned when testing.
    //       const prerenderedRouteCount = Object.keys(
    //         prerenderManifest?.routes ?? {},
    //       ).length;

    //       const seedFn = new Worker(
    //         `${name}RevalidationSeeder`,
    //         {
    //           description: `${name} ISR revalidation data seeder`,
    //           handler:
    //             openNextOutput.additionalProps.initializationFunction.handler,
    //           bundle: path.join(
    //             outputPath,
    //             openNextOutput.additionalProps.initializationFunction.bundle,
    //           ),
    //           runtime: "nodejs20.x",
    //           timeout: "900 seconds",
    //           memory: `${Math.min(
    //             10240,
    //             Math.max(128, Math.ceil(prerenderedRouteCount / 4000) * 128),
    //           )} MB`,
    //           permissions: [
    //             {
    //               actions: [
    //                 "dynamodb:BatchWriteItem",
    //                 "dynamodb:PutItem",
    //                 "dynamodb:DescribeTable",
    //               ],
    //               resources: [revalidationTable!.arn],
    //             },
    //           ],
    //           environment: {
    //             CACHE_DYNAMO_TABLE: revalidationTable!.name,
    //           },
    //           live: false,
    //           _ignoreCodeChanges: $dev,
    //           _skipMetadata: true,
    //         },
    //         { parent },
    //       );

    //       new pulumiAws.lambda.Invocation(
    //         `${name}RevalidationSeed`,
    //         {
    //           functionName: seedFn.nodes.function.name,
    //           triggers: {
    //             version: Date.now().toString(),
    //           },
    //           input: JSON.stringify({
    //             RequestType: "Create",
    //           }),
    //         },
    //         { parent, ignoreChanges: $dev ? ["*"] : undefined },
    //       );
    //     },
    //   );
    // }

    function removeSourcemaps() {
      // TODO: ↓↓↓ What does this mean? ↓↓↓
      // TODO set dependency
      // TODO ensure sourcemaps are removed in function code
      // We don't need to remove source maps in V3
      return;
      return outputPath.apply((outputPath) => {
        const files = globSync("**/*.js.map", {
          cwd: path.join(outputPath, ".open-next", "server-function"),
          nodir: true,
          dot: true,
        });
        for (const file of files) {
          fs.rmSync(
            path.join(outputPath, ".open-next", "server-function", file),
          );
        }
      });
    }

    function handleMissingSourcemap() {
      // TODO implement
      return;
      //if (doNotDeploy || this.args.edge) return;
      //const hasMissingSourcemap = useRoutes().every(
      //  ({ sourcemapPath, sourcemapKey }) => !sourcemapPath || !sourcemapKey
      //);
      //if (!hasMissingSourcemap) return;
      //// TODO set correct missing sourcemap value
      ////(this.serverFunction as SsrFunction)._overrideMissingSourcemap();
    }
  }

  /**
   * The URL of the Remix app.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the autogenerated CloudFront URL.
   */
  public get url() {
    return this.router.url;
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The AWS Lambda server function that renders the site.
       */
      server: this.server,
      /**
       * The Amazon S3 Bucket that stores the assets.
       */
      assets: this.assets,
    };
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        url: this.url,
      },
    };
  }
}

const __pulumiType = "sst:aws:Nextjs";
// @ts-expect-error
Nextjs.__pulumiType = __pulumiType;
