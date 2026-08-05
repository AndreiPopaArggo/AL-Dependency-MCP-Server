#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ALCliWrapper } from './cli/al-cli.js';
import { ALInstaller } from './cli/al-installer.js';
import { OptimizedSymbolDatabase } from './core/symbol-database.js';
import { ALPackageManager } from './core/package-manager.js';
import { ALMCPTools } from './tools/mcp-tools.js';
import { ParseProgress } from './parser/streaming-parser.js';

export class ALMCPServer {
  private server: Server;
  private alCli: ALCliWrapper;
  private database: OptimizedSymbolDatabase;
  private packageManager: ALPackageManager;
  private tools: ALMCPTools;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private toolCallCount: number = 0;

  constructor() {
    this.server = new Server(
      {
        name: 'al-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize components (AL CLI will be set up during start)
    this.alCli = new ALCliWrapper();
    this.database = new OptimizedSymbolDatabase();
    this.packageManager = new ALPackageManager(
      this.alCli,
      this.reportProgress.bind(this),
      this.database
    );
    this.tools = new ALMCPTools(this.database, this.packageManager);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'al_search_objects',
            description: 'Find AL objects by name, type, or business domain. Use this to discover which objects exist (e.g. "what tables relate to sales?"). Returns names, IDs, and types. Keep includeFields and includeProcedures false to avoid large responses — use al_get_object_summary or al_get_object_definition to inspect a specific object.',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'Search pattern (wildcards supported)',
                },
                objectType: {
                  type: 'string',
                  description: 'Filter by type',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Enum', 'EnumExtensionType', 'Interface', 'PermissionSet', 'PermissionSetExtension', 'XmlPort', 'Query'],
                },
                packageName: {
                  type: 'string',
                  description: 'Filter by package',
                },
                domain: {
                  type: 'string',
                  description: 'Business domain filter',
                  enum: ['Sales', 'Purchasing', 'Finance', 'Inventory', 'Manufacturing', 'Service'],
                },
                includeFields: {
                  type: 'boolean',
                  description: 'Include table fields (increases tokens)',
                  default: false,
                },
                includeProcedures: {
                  type: 'boolean',
                  description: 'Include procedures (increases tokens)',
                  default: false,
                },
                limit: {
                  type: 'number',
                  description: 'Max results (default: 20)',
                  default: 20,
                },
                offset: {
                  type: 'number',
                  description: 'Pagination offset (default: 0)',
                  default: 0,
                },
                summaryMode: {
                  type: 'boolean',
                  description: 'Summary view (default: true)',
                  default: true,
                },
              },
            },
          },
          {
            name: 'al_get_object_definition',
            description: 'Get the full definition of a known AL object — all fields with types and properties, procedure signatures with parameters, variables, and keys. Use this when you need exact field types, procedure parameters, or complete structural detail. Use fieldLimit/procedureLimit to control response size. For a lighter overview, prefer al_get_object_summary.',
            inputSchema: {
              type: 'object',
              properties: {
                objectId: {
                  type: 'number',
                  description: 'Object ID',
                },
                objectName: {
                  type: 'string',
                  description: 'Object name (alternative to ID)',
                },
                objectType: {
                  type: 'string',
                  description: 'Object type',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Enum', 'EnumExtensionType', 'Interface', 'PermissionSet', 'PermissionSetExtension', 'XmlPort', 'Query'],
                },
                packageName: {
                  type: 'string',
                  description: 'Package (for disambiguation)',
                },
                includeFields: {
                  type: 'boolean',
                  description: 'Include table fields',
                  default: true,
                },
                includeProcedures: {
                  type: 'boolean',
                  description: 'Include procedures',
                  default: true,
                },
                summaryMode: {
                  type: 'boolean',
                  description: 'Summary view (recommended)',
                  default: true,
                },
                fieldLimit: {
                  type: 'number',
                  description: 'Max fields (10 summary/100 full)',
                },
                procedureLimit: {
                  type: 'number',
                  description: 'Max procedures (10 summary/50 full)',
                },
              },
            },
          },
          {
            name: 'al_find_references',
            description: 'Find cross-object relationships — what extends, uses, or references a given AL object or field. Use this to trace dependencies: table extensions, field usage across codeunits/pages/reports, table relations, variable declarations, and parameters.',
            inputSchema: {
              type: 'object',
              properties: {
                targetName: {
                  type: 'string',
                  description: 'Target object or table name',
                },
                fieldName: {
                  type: 'string',
                  description: 'Field name (optional, use "*" for all fields)',
                },
                referenceType: {
                  type: 'string',
                  description: 'Reference type filter',
                  enum: ['extends', 'source_table', 'table_relation', 'field_usage', 'table_usage', 'variable', 'parameter', 'return_type'],
                },
                sourceType: {
                  type: 'string',
                  description: 'Source object type filter',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Enum', 'EnumExtensionType', 'Interface', 'PermissionSet', 'PermissionSetExtension', 'XmlPort', 'Query'],
                },
                includeContext: {
                  type: 'boolean',
                  description: 'Include detailed context',
                  default: false,
                },
              },
              required: ['targetName'],
            },
          },
          {
            name: 'al_search_object_members',
            description: 'Search within a specific AL object for procedures, fields, controls, or dataitems by name pattern. Use this when you know the object but need to find a specific member inside it (e.g. "find all Post* procedures in codeunit Sales-Post"). For page controls, returns the full layout path (e.g. content > Item > Base Unit of Measure). Use the group parameter to restrict control search to a specific fast tab.',
            inputSchema: {
              type: 'object',
              properties: {
                objectName: {
                  type: 'string',
                  description: 'Parent object name',
                },
                objectType: {
                  type: 'string',
                  description: 'Object type (optional)',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Query', 'XmlPort'],
                },
                memberType: {
                  type: 'string',
                  description: 'Member type to search',
                  enum: ['procedures', 'fields', 'controls', 'dataitems'],
                },
                pattern: {
                  type: 'string',
                  description: 'Filter pattern (wildcards supported)',
                },
                group: {
                  type: 'string',
                  description: 'For controls only: restrict search to a specific group/tab by name (e.g. "Item" to search only the Item fast tab)',
                },
                limit: {
                  type: 'number',
                  description: 'Max results (default: 20)',
                  default: 20,
                },
                offset: {
                  type: 'number',
                  description: 'Pagination offset (default: 0)',
                  default: 0,
                },
                includeDetails: {
                  type: 'boolean',
                  description: 'Include full details',
                  default: true,
                },
              },
              required: ['objectName', 'memberType'],
            },
          },
          {
            name: 'al_get_object_summary',
            description: 'Get a high-level overview of a known AL object — procedure categories, field groups, and key structure. Use this as the default way to understand what an object does before drilling into details with al_get_object_definition.',
            inputSchema: {
              type: 'object',
              properties: {
                objectName: {
                  type: 'string',
                  description: 'Object name',
                },
                objectType: {
                  type: 'string',
                  description: 'Object type (optional)',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Enum', 'EnumExtensionType', 'Interface', 'PermissionSet', 'PermissionSetExtension', 'XmlPort', 'Query'],
                },
              },
              required: ['objectName'],
            },
          },
          {
            name: 'al_get_source',
            description: 'Get AL source code for a standard BC object or a specific member (procedure body, field declaration, trigger). Use this when you need the actual implementation code — not just the structure from al_get_object_definition. Requires BC source files on the server.',
            inputSchema: {
              type: 'object',
              properties: {
                objectName: {
                  type: 'string',
                  description: 'Object name (e.g. "Sales-Post", "Item Card")',
                },
                objectType: {
                  type: 'string',
                  description: 'Object type (optional, for disambiguation)',
                  enum: ['Table', 'TableExtension', 'Page', 'PageExtension', 'Codeunit', 'Report', 'ReportExtension', 'Enum', 'EnumExtensionType', 'Interface', 'PermissionSet', 'PermissionSetExtension', 'XmlPort', 'Query'],
                },
                memberName: {
                  type: 'string',
                  description: 'Specific member to extract (e.g. "PostItemLine", "Base Unit of Measure"). Omit to get the object header.',
                },
                memberType: {
                  type: 'string',
                  description: 'Type of member to extract',
                  enum: ['procedure', 'trigger', 'field', 'control'],
                },
              },
              required: ['objectName'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const callId = ++this.toolCallCount;
      const argsJson = JSON.stringify(args ?? {});
      console.error(
        `[tool] #${callId} start ${name} args=${argsJson.length > 150 ? argsJson.slice(0, 150) + '…' : argsJson}`
      );
      const startedAt = Date.now();

      try {
        // Ensure AL packages are loaded before processing any tool call
        await this.ensureInitialized();

        const result = await this.dispatchTool(name, args);
        console.error(
          `[tool] #${callId} done ${name} ok ${Date.now() - startedAt}ms result=${this.summarizeResult(result)}`
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const logMessage = message.replace(/\s+/g, ' ');
        console.error(
          `[tool] #${callId} done ${name} error ${Date.now() - startedAt}ms "${logMessage.length > 200 ? logMessage.slice(0, 200) + '…' : logMessage}"`
        );
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async dispatchTool(name: string, args: unknown): Promise<{ content: { type: string; text: string }[] }> {
    switch (name) {
      case 'al_search_objects':
        // Handle domain filtering within search
        if (args && (args as any).domain) {
          const domainResult = await this.tools.searchByDomain(
            (args as any).domain,
            (args as any).objectType ? [(args as any).objectType] : undefined
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(domainResult, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.searchObjects(args as any), null, 2),
            },
          ],
        };

      case 'al_get_object_definition':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.getObjectDefinition(args as any), null, 2),
            },
          ],
        };

      case 'al_find_references':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.findReferences(args as any), null, 2),
            },
          ],
        };

      case 'al_search_object_members':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.searchObjectMembers(args as any), null, 2),
            },
          ],
        };

      case 'al_get_object_summary':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.getObjectSummary((args as any).objectName, (args as any).objectType), null, 2),
            },
          ],
        };

      case 'al_get_source':
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.tools.getSourceSnippet(args as any), null, 2),
            },
          ],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private summarizeResult(result: { content: { type: string; text: string }[] }): string {
    const bytes = result.content.reduce((sum, item) => sum + item.text.length, 0);
    let items: number | null = null;
    try {
      const parsed = JSON.parse(result.content[0]?.text ?? '');
      if (Array.isArray(parsed)) {
        items = parsed.length;
      } else if (parsed && typeof parsed === 'object') {
        const list = [parsed.results, parsed.objects, parsed.members, parsed.references, parsed.matches].find(
          Array.isArray
        );
        if (list) items = list.length;
      }
    } catch {
      // non-JSON result — report bytes only
    }
    return items !== null ? `${items} items, ${bytes} bytes` : `${bytes} bytes`;
  }

  private reportProgress(progress: ParseProgress): void {
    // Log progress to stderr so it doesn't interfere with MCP communication
    console.error(`[AL-MCP] ${progress.phase}: ${progress.processed}${progress.total ? `/${progress.total}` : ''} ${progress.currentObject || ''}`);
  }

  async start(): Promise<void> {
    // If AL_PACKAGES_PATH is set, pre-load packages before accepting connections
    const packagesPath = process.env.AL_PACKAGES_PATH;
    if (packagesPath) {
      try {
        await this.setupALCli();
        // Support multiple paths separated by ; (e.g. "/opt/al-mcp/bc26/.alpackages;/opt/al-mcp/bc27/.alpackages")
        const paths = packagesPath.split(';').map(p => p.trim()).filter(p => p);
        let totalObjects = 0, totalPackages = 0, totalMs = 0;
        for (const p of paths) {
          console.error(`Loading packages from ${p}...`);
          const result = await this.tools.loadPackages({ packagesPath: p, forceReload: false });
          totalObjects += result.totalObjects;
          totalPackages += result.packages.length;
          totalMs += result.loadTimeMs;
        }
        console.error(`Pre-loaded ${totalObjects} objects from ${totalPackages} packages in ${totalMs}ms`);
        this.isInitialized = true;
      } catch (error) {
        console.error(`Pre-load failed: ${error instanceof Error ? error.message : error}`);
        console.error('Server will continue — use al_packages to load manually');
      }
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AL MCP Server ready');
  }

  // Public methods for testing
  async initialize(): Promise<void> {
    await this.setupALCli();
    // Auto-discover packages in current working directory
    await this.tools.autoDiscoverPackages(process.cwd());
  }

  /**
   * Ensure AL packages are loaded (lazy initialization)
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    // Start initialization
    this.initializationPromise = this.performInitialization();
    await this.initializationPromise;
  }

  private async performInitialization(): Promise<void> {
    try {
      console.error('Setting up AL MCP Server...');

      // Setup AL CLI
      await this.setupALCli();

      // No automatic package loading - require explicit tool calls
      console.error('AL MCP Server ready. Use al_packages to load AL symbols before searching.');

      this.isInitialized = true;
    } catch (error) {
      console.error('Auto-initialization failed:', error);
      // Don't throw - allow server to continue with limited functionality
      this.isInitialized = true; // Prevent retry loops
    } finally {
      this.initializationPromise = null;
    }
  }

  private async setupALCli(): Promise<void> {
    console.error('Setting up AL CLI...');

    const installer = new ALInstaller();
    const result = await installer.ensureALAvailable();

    if (result.success) {
      console.error(result.message);
      if (result.alPath) {
        this.alCli.setALCommand(result.alPath);
      }
    } else {
      console.error(result.message);

      if (result.requiresManualInstall) {
        console.error('');
        console.error(installer.getManualInstallInstructions());
      }

      console.error('Server will continue with limited functionality (symbol parsing will fail)');
      console.error('MCP tools will still work for basic operations and error reporting');
    }
  }
}

// Main function for programmatic use
export async function main(): Promise<void> {
  const server = new ALMCPServer();
  await server.start();
}

// Start the server if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to start AL MCP Server:', error);
    process.exit(1);
  });
}
