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
        const { files: excludeFiles } = await this.generate();
        if (this.pluginConfig.reloadHandler) {
          await this.watch(excludeFiles);
        }
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        await this.generate();
      },
    };
  }

  generate = async (): Promise<{
    files: string[];
  }> => {
    const { spec, routes, client } = this.pluginConfig;
    if (!spec) {
      throw new Error(
        "No custom.tsoa.spec configuration found in serverless.yml"
      );
    }

    if (!routes) {
      throw new Error(
        "No custom.tsoa.routes configuration found in serverless.yml"
      );
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

    const specDirectory = spec.outputDirectory;
    const specFile = path.join(
      specDirectory,
      `${spec.specFileBaseName || "swagger"}.${spec.yaml ? "yaml" : "json"}`
    );
    const workdirSpecFile = path.join(workDir, specFile);
    spec.outputDirectory = path.join(workDir, spec.outputDirectory);

    const routesDirectory = routes.routesDir;
    const routesFile = path.join(
      routesDirectory,
      `${routes.routesFileName || "routes.ts"}`
    );

    await generateTsoaSpec(spec);
    await this.conditionalCopy(workdirSpecFile, specFile);
    this.log.verbose(`Generated OpenAPI Spec: ${specFile}`);

    await Promise.all(
      openApiDestinations.map(async (dest) => {
        await this.conditionalCopy(specFile, path.join(dest, specFile));
      })
    );

    await generateTsoaRoutes(routes);
    this.log.verbose(`Generated OpenAPI Routes: ${routesFile}`);

    let clientFiles: string[] = [];
    const target = typeof client === "string" ? client : client?.target;

    if (client && target) {
      const workdirTarget = path.join(workDir, target);

      let output: ClientOutputConfig =
        typeof client === "string"
          ? { target: workdirTarget }
          : { ...client, target: workdirTarget };

      await generateClientSpec(
        {
          input: {
            target: path.join(this.serverlessConfig.servicePath, specFile),
          },
          output,
        },
        this.serverlessConfig.servicePath
      );

      // TODO: Gather additional client files for more advanced configurations

      await this.conditionalCopy(workdirTarget, target);
      this.log.verbose(`Generated OpenAPI Client: ${target}`);
      clientFiles.push(target);
    }

    return {
      files: [specFile, routesFile, ...clientFiles],
    };
  };

  watch = async (excludeFiles: string[]): Promise<void> => {
    const watcher = chokidar.watch(
      path.join(this.serverlessConfig.servicePath),
      {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        usePolling: false,
      }
    );

    watcher.unwatch(excludeFiles);

    const handler = async (file: string) => {
      this.log.verbose(`File ${file} has been changed`);
      await this.generate();
      watcher.on("change", handler);
    };

    watcher.on("change", async (file) => {
      watcher.off("change", handler);
      await handler(file);
    });
  };

  conditionalCopy = async (src: string, dest: string): Promise<void> => {
    // hash src and dest
    const srcHash = await this.hashFile(src);
    const destHash = await this.hashFile(dest);

    if (srcHash !== destHash) {
      await fs.ensureDir(path.dirname(dest));
      await fs.copy(src, dest);
      this.log.verbose(`Copied ${src} to ${dest}`);
    }
  };

  hashFile = async (file: string): Promise<string> => {
    try {
      const buffer = await fs.readFile(file);
      return sha1(buffer);
    } catch (e) {
      // Return randomness to force a copy
      return sha1(uuid());
    }
  };
}

module.exports = ServerlessTsoa;
