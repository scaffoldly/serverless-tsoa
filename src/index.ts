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
        const { specFile, routesFile, clientFiles } = await this.generate();
        if (this.pluginConfig.reloadHandler) {
          await this.watch(specFile, routesFile, clientFiles);
        }
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        await this.generate();
      },
    };
  }

  generate = async (): Promise<{
    specFile: string;
    routesFile: string;
    clientFiles: string[];
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

    // Do generate into a workdir to avoid excessive reloading
    const workDir = path.join(
      this.serverlessConfig.servicePath,
      `.${PLUGIN_NAME}`
    );

    const specOutputDirectory = spec.outputDirectory;
    const specOutputFile = path.join(
      specOutputDirectory,
      `${spec.specFileBaseName || "swagger"}.${spec.yaml ? "yaml" : "json"}`
    );
    const workdirSpecOutputFile = path.join(workDir, specOutputFile);
    spec.outputDirectory = path.join(workDir, spec.outputDirectory);

    const routesOutputDirectory = routes.routesDir;
    const routesOutputFile = path.join(
      routesOutputDirectory,
      `${routes.routesFileName || "routes.ts"}`
    );

    // DEVNOTE: Can't do workdir for routes since tsoa screws up relatve paths
    // const workdirRoutesOutputFile = path.join(workDir, routesOutputFile);
    // routes.routesDir = path.join(workDir, routes.routesDir);

    await generateTsoaSpec(spec);
    this.log.verbose(`Generated OpenAPI Spec: ${specOutputFile}`);

    await this.conditionalCopy(workdirSpecOutputFile, specOutputFile);

    await generateTsoaRoutes(routes);
    this.log.verbose(`Generated OpenAPI Routes: ${routesOutputFile}`);

    let clientFiles: string[] = [];

    if (client) {
      await generateClientSpec(
        {
          input: {
            target: path.join(
              this.serverlessConfig.servicePath,
              specOutputFile
            ),
          },
          output: client,
        },
        this.serverlessConfig.servicePath
      );
      const target = typeof client === "string" ? client : client.target;

      // TODO: Gather additional client files for more advanced configurations
      if (target) {
        this.log.verbose(`Generated OpenAPI Client: ${target}`);
        clientFiles.push(target);
      }
    }

    // DEVNOTE: Can't do workdir for routes since tsoa screws up relatve paths
    // await this.conditionalCopy(workdirRoutesOutputFile, routesOutputFile);

    return {
      specFile: path.join(this.serverlessConfig.servicePath, specOutputFile),
      routesFile: path.join(
        this.serverlessConfig.servicePath,
        routesOutputFile
      ),
      clientFiles,
    };
  };

  watch = async (
    specFile: string,
    routesFile: string,
    clientFiles: string[]
  ): Promise<void> => {
    const watcher = chokidar.watch(
      path.join(this.serverlessConfig.servicePath),
      {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        usePolling: false,
      }
    );

    watcher.unwatch([specFile, routesFile, ...clientFiles]);

    watcher.on("change", async (file) => {
      this.log.verbose(`File ${file} has been changed`);
      await this.generate();
    });
  };

  conditionalCopy = async (src: string, dest: string): Promise<void> => {
    // hash src and dest
    const srcHash = await this.hashFile(src);
    const destHash = await this.hashFile(dest);

    if (srcHash !== destHash) {
      await fs.ensureDir(path.dirname(dest));
      await fs.copy(src, dest);
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
