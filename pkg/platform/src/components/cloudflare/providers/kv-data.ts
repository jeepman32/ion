import fs from "fs";
import { CustomResourceOptions, Input, dynamic } from "@pulumi/pulumi";
import { FetchResult, cfFetch } from "../helpers/fetch.js";

interface KvDataEntry {
  source: string;
  key: string;
  hash: string;
  contentType: string;
  cacheControl?: string;
}

interface KvBulk {
  base64: boolean;
  key: string;
  metadata: { [key: string]: any };
  value: string;
  expiration?: number;
  expiration_ttl?: number;
}

export interface KvDataInputs {
  accountId: Input<Inputs["accountId"]>;
  namespaceId: Input<Inputs["namespaceId"]>;
  entries: Input<Inputs["entries"]>;
}

interface Inputs {
  accountId: string;
  namespaceId: string;
  entries: KvDataEntry[];
}

class Provider implements dynamic.ResourceProvider {
  async create(inputs: Inputs): Promise<dynamic.CreateResult> {
    await this.upload(inputs.accountId, inputs.namespaceId, inputs.entries, []);
    return { id: "data" };
  }

  async update(
    id: string,
    olds: Inputs,
    news: Inputs,
  ): Promise<dynamic.UpdateResult> {
    await this.upload(
      news.accountId,
      news.namespaceId,
      news.entries,
      news.namespaceId === olds.namespaceId ? olds.entries : [],
    );
    return {};
  }

  async upload(
    accountId: string,
    namespaceId: string,
    entries: KvDataEntry[],
    oldEntries: KvDataEntry[],
  ) {
    const oldFilesMap = new Map(oldEntries.map((f) => [f.key, f]));
    const uploadFiles = entries.filter((entry) => {
      const old = oldFilesMap.get(entry.key);
      return (
        old?.hash !== entry.hash ||
        old?.contentType !== entry.contentType ||
        old?.cacheControl !== entry.cacheControl
      );
    });

    // Cloudflare bulk upload only allows 10,000 KV pairs to be uploaded at once.
    const chunkSize = 10000;

    // Create an array as with the same length as the expected chunks, I.E. if there's 15,000
    // pairs, create 2 chunks, and then for each chunk, slice uploadFiles to populate that chunk.
    const uploadFilesChunked = Array.from(
      { length: Math.ceil(uploadFiles.length / chunkSize) },
      (_, index) =>
        uploadFiles.slice(index * chunkSize, index * chunkSize + chunkSize),
    );

    const promises: Promise<FetchResult<unknown>>[] = [];

    for (const chunk of uploadFilesChunked) {
      const body: KvBulk[] = [];

      for (const { contentType, cacheControl, key, source } of chunk) {
        body.push({
          // This is base64 DECODE:
          // Whether or not the server should base64 decode the value before storing it.
          // Useful for writing values that wouldn't otherwise be valid JSON strings, such as images.
          base64: false,
          key,
          metadata: {
            contentType,
            cacheControl,
          },
          value: fs.readFileSync(source, "base64"),
        });
      }

      // There be dragons 🐲🐲🐲
      // Don't change from bulk (Write multiple key-value pairs) to single upload
      // (Write key-value pair with metadata) as the single upload method can cause invalid URLs to generate,
      // I.E /accounts/[redacted]/storage/kv/namespaces/[redacted]/values/_assets/_next/static/chunks/app/(payload)/admin/[[...segments]]/page.js
      promises.push(
        cfFetch(
          `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
          {
            headers: {
              "Content-Type": "application/json",
            },
            method: "PUT",
            body: JSON.stringify(body),
          },
        ),
      );
    }

    await Promise.all(promises).catch((error: unknown) => {
      console.error(error);

      throw error;
    });
  }
}

export class KvData extends dynamic.Resource {
  constructor(name: string, args: KvDataInputs, opts?: CustomResourceOptions) {
    super(new Provider(), `${name}.sst.cloudflare.KvPairs`, args, opts);
  }
}
