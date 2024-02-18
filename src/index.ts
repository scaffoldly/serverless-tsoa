import path from "path";
import fs from "fs-extra";
import { sha1 } from "js-sha1";
import { v4 as uuid } from "uuid";
import chokidar from "chokidar";
import {
  generateRoutes,
  generateSpec,
  ExtendedRoutesConfig,
  ExtendedSpecConfig,
} from "tsoa";

type PluginName = "tsoa";
const PLUGIN_NAME: PluginName = "tsoa";

type PluginConfig = {
  reloadHandler?: boolean;
  spec?: ExtendedSpecConfig;
  routes?: ExtendedRoutesConfig;
};

type ServerlessCustom = {
  tsoa?: PluginConfig;
};

type ServerlessService = {
  service: string;
  custom?: ServerlessCustom;
  provider: {
    stage: string;
    environment?: { [key: string]: string | { Ref?: string } };
  };
  getAllFunctions: () => string[];
  getFunction: (functionName: string) => {
    name: string;
    events?: any[];
  };
};

type ServerlessConfig = {
  servicePath: string;
};

type Serverless = {
  service: ServerlessService;
  pluginManager: {
    spawn: (command: string) => Promise<void>;
  };
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
        await this.generateSpecAndRoutes();
      },
      "before:offline:start": async () => {
        this.log.verbose("before:offline:start");
        const { specFile, routesFile } = await this.generateSpecAndRoutes();
        if (this.pluginConfig.reloadHandler) {
          await this.watch(specFile, routesFile);
        }
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        await this.generateSpecAndRoutes();
      },
    };
  }

  generateSpecAndRoutes = async (): Promise<{
    specFile: string;
    routesFile: string;
  }> => {
    const { spec, routes } = this.pluginConfig;
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

    this.log.verbose(`Generating spec...`);
    await generateSpec(spec);
    this.log.verbose(`Generating routes...`);
    await generateRoutes(routes);

    await this.conditionalCopy(workdirSpecOutputFile, specOutputFile);

    // DEVNOTE: Can't do workdir for routes since tsoa screws up relatve paths
    // await this.conditionalCopy(workdirRoutesOutputFile, routesOutputFile);

    return { specFile: specOutputFile, routesFile: routesOutputFile };
  };

  watch = async (specFile: string, routesFile: string): Promise<void> => {
    const watcher = chokidar.watch(
      path.join(this.serverlessConfig.servicePath),
      {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        usePolling: false,
      }
    );

    watcher.unwatch([specFile, routesFile]);

    watcher.on("change", async (file) => {
      this.log.verbose(`File ${file} has been changed`);
      await this.generateSpecAndRoutes();
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
