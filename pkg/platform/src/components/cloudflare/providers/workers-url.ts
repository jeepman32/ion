import { CustomResourceOptions, Input, Output, dynamic } from "@pulumi/pulumi";
import { cfFetch } from "../helpers/fetch.js";

export interface WorkersUrlInputs {
  accountId: Input<string>;
  scriptName: Input<string>;
  enabled: Input<boolean>;
}

interface Inputs {
  accountId: string;
  scriptName: string;
  enabled: boolean;
}

class Provider implements dynamic.ResourceProvider {
  async create(inputs: Inputs): Promise<dynamic.CreateResult> {
    return {
      id: inputs.scriptName,
      outs: { url: await this.process(inputs) },
    };
  }

  async update(
    id: string,
    olds: Inputs,
    news: Inputs,
  ): Promise<dynamic.UpdateResult> {
    const url = await this.process(news);
    return {
      outs: url ? { url } : {},
    };
  }

  async process(inputs: Inputs) {
    if (inputs.enabled === false) {
      await this.setEnabledFlag(inputs);
      return undefined;
    }

    const [userSubdomain] = await Promise.all([
      this.getWorkersDevSubdomain(inputs),
      this.setEnabledFlag(inputs),
    ]);
    return `${inputs.scriptName}.${userSubdomain}.workers.dev`;
  }

  async getWorkersDevSubdomain(inputs: Inputs) {
    try {
      const ret = await cfFetch<{ subdomain: string }>(
        `/accounts/${inputs.accountId}/workers/subdomain`,
        {
          headers: { "Content-Type": "application/json" },
        },
      );
      return ret.result.subdomain;
    } catch (error: any) {
      console.log(error);
      throw error;
    }
  }

  async setEnabledFlag(inputs: Inputs) {
    try {
      const ret = await cfFetch(
        `/accounts/${inputs.accountId}/workers/scripts/${inputs.scriptName}/subdomain`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: inputs.enabled }),
        },
      );
      // Add a delay when the subdomain is first created.
      // This is to prevent an issue where a negative cache-hit
      // causes the subdomain to be unavailable for 30 seconds.
      // This is a temporary measure until we fix this on the edge.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch (error: any) {
      console.log(error);
      throw error;
    }
  }
}

export interface WorkersUrl {
  url: Output<string | undefined>;
}

export class WorkersUrl extends dynamic.Resource {
  constructor(
    name: string,
    args: WorkersUrlInputs,
    opts?: CustomResourceOptions,
  ) {
    super(
      new Provider(),
      `${name}.sst.cloudflare.WorkersUrl`,
      { ...args, url: undefined },
      opts,
    );
  }
}
