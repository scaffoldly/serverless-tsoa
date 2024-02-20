import path from "path";
import fs from "fs-extra";
import { sha1 } from "js-sha1";
import { v4 as uuid } from "uuid";
import chokidar from "chokidar";
import {
  generateRoutes as generateTsoaRoutes,
  generateSpec as generateTsoaSpec,
  ExtendedRoutesConfig,
  ExtendedSpecConfig,
} from "tsoa";
import { generate as generateClientSpec } from "orval";
import { OutputOptions as ClientOutputConfig } from "@orval/core";

type PluginName = "tsoa";
const PLUGIN_NAME: PluginName = "tsoa";

type PluginConfig = {
  reloadHandler?: boolean;
  spec?: ExtendedSpecConfig;
  routes?: ExtendedRoutesConfig;
  client?: string | ClientOutputConfig;
};

type ServerlessCustom = {
  tsoa?: PluginConfig;
  esbuild?: {
    outputWorkFolder?: string;
    outputBuildFolder?: string;
  };
};

type ServerlessService = {
  service: string;
  custom?: ServerlessCustom;
};

type ServerlessConfig = {
  servicePath: string;
};

type Serverless = {
  service: ServerlessService;
  config: any;
};

type Options = {
  verbose?: boolean;
  log?: ServerlessLog;
};

type ServerlessLog = ((message: string) => void) & {
  verbose: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
};

class Log {
  constructor(private options: Options) {}

  static msg = (message: string) => {
    return `[${PLUGIN_NAME}] ${message}`;
  };

  log = (message: string) => {
    if (this.options.log) {
      this.options.log(Log.msg(message));
    } else {
      console.log(Log.msg(message));
    }
  };

  verbose = (message: string) => {
    if (this.options.log) {
      this.options.log.verbose(Log.msg(message));
    } else {
      console.log(Log.msg(message));
    }
  };

  warning = (message: string) => {
    if (this.options.log) {
      this.options.log.warning(Log.msg(message));
    } else {
      console.warn(Log.msg(message));
    }
  };

  error = (message: string) => {
    if (this.options.log) {
      this.options.log.error(Log.msg(message));
    } else {
      console.error(Log.msg(message));
    }
  };
}

class ServerlessTsoa {
  log: Log;
  specHash?: string;

  serverless: Serverless;
  serverlessConfig: ServerlessConfig;
  pluginConfig: PluginConfig;

  hooks: {
    [key: string]: () => Promise<void>;
  };

  commands: {
    [key: string]: {
      lifecycleEvents: string[];
    };
  };

  constructor(serverless: Serverless, protected options: Options) {
    this.serverless = serverless;
    this.serverlessConfig = serverless.config;
    this.pluginConfig =
      (this.serverless.service.custom &&
        this.serverless.service.custom[PLUGIN_NAME]) ||
      {};

    this.log = new Log(options);

    this.commands = {
      tsoa: {
        lifecycleEvents: ["run"],
      },
    };

    this.hooks = {
      initialize: async () => {},
      "tsoa:run": async () => {
        await this.generate();
      },
      "before:offline:start": async () => {
        this.log.verbose("before:offline:start");
        await this.generate();
        await this.watch();
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        await this.generate();
      },
    };
  }

  get specFile(): string {
    const { spec } = this.pluginConfig;
    if (!spec) {
      throw new Error(
        "No custom.tsoa.spec configuration found in serverless.yml"
      );
    }

    const specDirectory = spec.outputDirectory;

    return path.join(
      specDirectory,
      `${spec.specFileBaseName || "swagger"}.${spec.yaml ? "yaml" : "json"}`
    );
  }

  get routesFile(): string {
    const { routes } = this.pluginConfig;
    if (!routes) {
      throw new Error(
        "No custom.tsoa.routes configuration found in serverless.yml"
      );
    }

    const routesDirectory = routes.routesDir;

    return path.join(
      routesDirectory,
      `${routes.routesFileName || "routes.ts"}`
    );
  }

  get clientFiles(): string[] {
    const { client } = this.pluginConfig;
    if (!client) {
      return [];
    }

    let clientFiles: string[] = [];

    if (typeof client === "string") {
      clientFiles.push(client);
    } else {
      if (client.target) {
        clientFiles.push(client.target);
      }
    }

    // TODO: Discover more autogen files from orval

    return clientFiles;
  }

  generate = async (): Promise<void> => {
    let { spec, routes } = this.pluginConfig;
    if (!spec) {
      throw new Error(
        "No custom.tsoa.spec configuration found in serverless.yml"
      );
    } else {
      spec = JSON.parse(JSON.stringify(spec)) as ExtendedSpecConfig;
    }

    if (!routes) {
      throw new Error(
        "No custom.tsoa.routes configuration found in serverless.yml"
      );
    } else {
      routes = JSON.parse(JSON.stringify(routes)) as ExtendedRoutesConfig;
    }

    let openApiDestinations: string[] = [];

    const { esbuild } = this.serverless.service.custom || {};

    if (esbuild) {
      const outputWorkFolder = esbuild.outputWorkFolder || ".esbuild";
      const outputBuildFolder = esbuild.outputBuildFolder || ".build";
      openApiDestinations.push(path.join(outputWorkFolder, outputBuildFolder));
    }

    // TODO: support webpack and native bundling to .serverless

    // Generate into a workdir to avoid excessive reloading
    const workDir = path.join(
      this.serverlessConfig.servicePath,
      `.${PLUGIN_NAME}`
    );

    const workdirSpecFile = path.join(workDir, this.specFile);
    spec.outputDirectory = path.join(workDir, spec.outputDirectory);

    try {
      await generateTsoaSpec(spec);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
      this.specHash = undefined;
      this.log.warning(`Unable to generate OpenAPI Spec: ${e.message}`);
      return;
    }

    const newSpecHash = await this.hashFile(workdirSpecFile);

    // Nothing changed, bail early
    if (this.specHash === newSpecHash) {
      return;
    } else {
      this.log.verbose(`Generated OpenAPI Spec`);
      this.specHash = newSpecHash;
    }

    await this.conditionalCopy(workdirSpecFile, this.specFile);

    // Using .then becuse the following functions are not dependent on each other
    generateTsoaRoutes({ ...routes, noWriteIfUnchanged: true })
      .then(() => {
        this.log.verbose(`Generated OpenAPI Routes: ${this.routesFile}`);
      })
      .catch((e) => {
        this.log.warning(`Unable to generate OpenAPI Routes: ${e.message}`);
      });

    this.generateClientSpec(workDir)
      .then((clientFile) => {
        if (clientFile) {
          this.log.verbose(`Generated OpenAPI Client: ${clientFile}`);
        }
      })
      .catch((e) => {
        this.log.warning(`Unable to generate OpenAPI Client: ${e.message}`);
      });

    openApiDestinations.map((destination) =>
      this.conditionalCopy(this.specFile, path.join(destination, this.specFile))
        .then((dest) => {
          if (dest) {
            this.log.verbose(`Copied OpenAPI Spec to: ${dest}`);
          }
        })
        .catch((e) => {
          this.log.warning(`Unable to copy OpenAPI Spec: ${e.message}`);
        })
    );
  };

  generateClientSpec = async (workDir: string): Promise<string | undefined> => {
    const { client } = this.pluginConfig;
    if (!client) {
      return;
    }

    const target = typeof client === "string" ? client : client.target;
    if (!target) {
      return;
    }

    const workdirTarget = path.join(workDir, target);

    const output: ClientOutputConfig =
      typeof client === "string"
        ? { target: workdirTarget }
        : { ...client, target: workdirTarget };

    await generateClientSpec(
      {
        input: {
          target: this.specFile,
        },
        output,
      },
      this.serverlessConfig.servicePath
    );

    await this.conditionalCopy(workdirTarget, target);

    return target;
  };

  watch = async (): Promise<void> => {
    if (!this.pluginConfig.reloadHandler) {
      return;
    }

    const watcher = chokidar.watch(
      path.join(this.serverlessConfig.servicePath, "src"),
      {
        awaitWriteFinish: true,
        atomic: true,
        ignorePermissionErrors: true,
        persistent: true,
        ignored: /(^|[\/\\])\../, // ignore dotfiles
      }
    );

    watcher.unwatch([this.specFile, this.routesFile, ...this.clientFiles]);

    watcher.on("change", (file) => {
      watcher.close();
      this.log.verbose(`File ${file} has been changed`);
      this.generate().then(() => {
        this.watch();
      });
    });
  };

  conditionalCopy = async (
    src: string,
    dest: string
  ): Promise<string | undefined> => {
    // hash src and dest
    const [srcHash, destHash] = await Promise.all([
      this.hashFile(src),
      this.hashFile(dest),
    ]);

    if (srcHash === destHash) {
      return;
    }

    await fs.ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
    return dest;
  };

  hashFile = async (file: string): Promise<string> => {
    try {
      const buffer = await fs.readFile(file);
      return sha1(buffer);
    } catch (e) {
      this.log.verbose(`Error hashing file: ${file}`);
      // Return randomness to force a copy
      return sha1(uuid());
    }
  };
}

module.exports = ServerlessTsoa;
