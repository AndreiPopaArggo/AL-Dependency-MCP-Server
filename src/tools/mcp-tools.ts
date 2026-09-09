import {
  SearchObjectsArgs,
  GetObjectDefinitionArgs,
  FindReferencesArgs,
  LoadPackagesArgs,
  SearchProceduresArgs,
  SearchFieldsArgs,
  SearchControlsArgs,
  SearchDataItemsArgs,
  FindFieldReferencesArgs,
  FindFieldUsageArgs,
  SearchObjectsResult,
  GetObjectDefinitionResult,
  FindReferencesResult,
  LoadPackagesResult,
  ListPackagesResult,
  SearchProceduresResult,
  SearchFieldsResult,
  SearchControlsResult,
  SearchDataItemsResult,
  FindFieldReferencesResult,
  FindFieldUsageResult
} from '../types/mcp-types';
import { ALObjectDefinition, ALFieldReference } from '../types/al-types';
import { OptimizedSymbolDatabase } from '../core/symbol-database';
import { ALPackageManager } from '../core/package-manager';
import * as fs from 'fs';
import * as path from 'path';

export class ALMCPTools {
  private sourcePaths: string[] = [];

  constructor(
    private database: OptimizedSymbolDatabase,
    private packageManager: ALPackageManager
  ) {
    // Initialize source paths from environment variable
    const srcPath = process.env.AL_SOURCE_PATH;
    if (srcPath) {
      this.sourcePaths = srcPath.split(';').map(p => p.trim()).filter(p => p);
    }
  }

  /**
   * Check if database is empty and return guidance message if needed
   */
  private checkDatabaseLoaded(): { isEmpty: boolean; message?: string } {
    const stats = this.database.getStatistics();
    if (stats.totalObjects === 0) {
      return {
        isEmpty: true,
        message: `No AL packages loaded from YOUR WORKSPACE. This tool analyzes compiled AL code (.app files), NOT documentation.

To load your workspace packages, use: al_packages with action='load' and path='<absolute-path-to-al-project>'

Example: path="/path/to/my-al-project" (folder containing .alpackages/ or app.json)

The tool auto-discovers .alpackages directories by default. Use absolute paths like "/path/to/project" or "C:\\path\\to\\project".

NOTE: For documentation and code examples, use microsoft_docs_search or microsoft_code_sample_search instead.`
      };
    }
    return { isEmpty: false };
  }

  /**
   * Search AL objects across all loaded packages
   */
  async searchObjects(args: SearchObjectsArgs): Promise<SearchObjectsResult> {
    const startTime = Date.now();
    
    try {
      // Check if database has packages loaded
      const dbCheck = this.checkDatabaseLoaded();
      if (dbCheck.isEmpty) {
        throw new Error(dbCheck.message!);
      }

      // Set default limits to prevent massive responses
      const limit = args.limit || 20; // Reduced from unlimited to 20
      const offset = args.offset || 0;
      const summaryMode = args.summaryMode !== false; // Default to summary mode
      
      // Perform the search
      const allObjects = this.database.searchObjects(
        args.pattern,
        args.objectType,
        args.packageName
      );

      // Apply pagination
      const totalFound = allObjects.length;
      const paginatedObjects = allObjects.slice(offset, offset + limit);

      // Enrich with additional data if requested
      const enrichedObjects = paginatedObjects.map(obj => {
        let enriched = { ...obj };
        
        // In summary mode, limit the detail included
        if (summaryMode) {
          // Trim properties to only essential ones
          if (enriched.Properties) {
            const essentialProps = enriched.Properties.filter(p => 
              ['Caption', 'TableType', 'DataClassification', 'LookupPageID'].includes(p.Name)
            ).slice(0, 4);
            enriched.Properties = essentialProps;
          }
          
          // Summary mode: just counts for fields/procedures
          if (args.includeFields && (obj.Type === 'Table' || obj.Type === 'TableExtension')) {
            const fields = this.database.getObjectFields(obj);
            (enriched as any).FieldCount = fields.length;
            (enriched as any).Fields = fields.slice(0, 3); // Show first 3 fields
          }
          
          if (args.includeProcedures) {
            const procedures = this.database.getObjectProceduresFor(obj);
            if (procedures.length > 0) {
              (enriched as any).ProcedureCount = procedures.length;
              (enriched as any).Procedures = procedures.slice(0, 3); // Show first 3 procedures
            }
          }
        } else {
          // Full mode - include everything but still apply reasonable limits
          if (args.includeFields && (obj.Type === 'Table' || obj.Type === 'TableExtension')) {
            const fields = this.database.getObjectFields(obj);
            (enriched as any).Fields = fields.slice(0, 50); // Max 50 fields
            if (fields.length > 50) {
              (enriched as any).TotalFieldCount = fields.length;
            }
          }
          
          if (args.includeProcedures) {
            const procedures = this.database.getObjectProceduresFor(obj);
            if (procedures.length > 0) {
              (enriched as any).Procedures = procedures.slice(0, 20); // Max 20 procedures
              if (procedures.length > 20) {
                (enriched as any).TotalProcedureCount = procedures.length;
              }
            }
          }
        }

        return enriched;
      });

      const executionTime = Date.now() - startTime;

      return {
        objects: enrichedObjects,
        totalFound,
        returned: enrichedObjects.length,
        offset,
        limit,
        hasMore: offset + limit < totalFound,
        summaryMode,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search failed: ${error}`);
    }
  }

  /**
   * Get complete object definition with all metadata
   */
  async getObjectDefinition(args: GetObjectDefinitionArgs): Promise<GetObjectDefinitionResult> {
    const startTime = Date.now();
    
    try {
      // Check if database has packages loaded
      const dbCheck = this.checkDatabaseLoaded();
      if (dbCheck.isEmpty) {
        throw new Error(dbCheck.message!);
      }

      let object: any;
      
      // Support both objectId and objectName lookup
      if (args.objectId && args.objectType) {
        const key = `${args.objectType}:${args.objectId}`;
        object = this.database.getObjectById(key);
      } else if (args.objectName) {
        const results = this.database.searchObjects(args.objectName, args.objectType, args.packageName);
        object = results.find(o => o.Name === args.objectName);
      }
      
      if (!object) {
        const identifier = args.objectId ? `${args.objectType} ${args.objectId}` : args.objectName;
        throw new Error(`Object not found: ${identifier}`);
      }

      // If package is specified, verify it matches
      if (args.packageName && object.PackageName !== args.packageName) {
        const identifier = args.objectId ? `${args.objectType} ${args.objectId}` : args.objectName;
        throw new Error(`Object ${identifier} not found in package ${args.packageName}`);
      }

      const summaryMode = args.summaryMode !== false; // Default to summary
      const fieldLimit = args.fieldLimit || (summaryMode ? 10 : 100);
      const procedureLimit = args.procedureLimit || (summaryMode ? 10 : 50);

      // Build definition with intelligent limiting
      const definition: ALObjectDefinition = {
        ...object,
        Fields: undefined,
        Procedures: undefined,
        Dependencies: undefined,
        Keys: undefined
      };

      // Add fields for tables
      if ((object.Type === 'Table' || object.Type === 'TableExtension') && (args.includeFields !== false)) {
        const allFields = this.database.getObjectFields(object);
        definition.Fields = allFields.slice(0, fieldLimit);
        if (allFields.length > fieldLimit) {
          (definition as any).TotalFieldCount = allFields.length;
          (definition as any).FieldsShown = fieldLimit;
        }
      }

      // Add procedures for codeunits
      if (args.includeProcedures !== false) {
        const allProcedures = this.database.getObjectProceduresFor(object);
        definition.Procedures = allProcedures.slice(0, procedureLimit);
        if (allProcedures.length > procedureLimit) {
          (definition as any).TotalProcedureCount = allProcedures.length;
          (definition as any).ProceduresShown = procedureLimit;
        }
      }

      // Add keys for tables
      if ((object.Type === 'Table' || object.Type === 'TableExtension') && (object as any).Keys) {
        definition.Keys = (object as any).Keys;
      }

      // Only include dependencies in summary mode with limits
      if (!summaryMode) {
        const allDeps = this.database.findReferences(object.Name, 'uses');
        definition.Dependencies = allDeps.slice(0, 20); // Max 20 dependencies
        if (allDeps.length > 20) {
          (definition as any).TotalDependencyCount = allDeps.length;
        }
      }

      const executionTime = Date.now() - startTime;

      return {
        object: definition,
        summaryMode,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Get object definition failed: ${error}`);
    }
  }

  /**
   * Find references to a target object or field
   */
  async findReferences(args: any): Promise<any> {
    const startTime = Date.now();

    try {
      const checkResult = this.checkDatabaseLoaded();
      if (checkResult.isEmpty) {
        throw new Error(checkResult.message!);
      }

      // Check if this is a field reference request
      if (args.fieldName) {
        // Field reference search
        const fieldReferences = this.database.findFieldReferences(args.targetName, args.fieldName);

        // Apply filters if specified
        let filteredRefs = fieldReferences;
        if (args.referenceType) {
          filteredRefs = filteredRefs.filter(ref => ref.referenceType === args.referenceType);
        }
        if (args.sourceType) {
          filteredRefs = filteredRefs.filter(ref => ref.sourceObjectType === args.sourceType);
        }

        // Build summary statistics
        const summary = this.buildFieldReferenceSummary(filteredRefs);

        const executionTime = Date.now() - startTime;

        return {
          type: 'field_references',
          tableName: args.targetName,
          fieldName: args.fieldName,
          references: filteredRefs,
          totalFound: filteredRefs.length,
          summary,
          executionTimeMs: executionTime
        };
      } else {
        // Object reference search (existing functionality)
        const references = this.database.findReferences(
          args.targetName,
          args.referenceType,
          args.sourceType
        );

        const executionTime = Date.now() - startTime;

        return {
          type: 'object_references',
          targetName: args.targetName,
          references,
          totalFound: references.length,
          executionTimeMs: executionTime
        };
      }
    } catch (error) {
      throw new Error(`Find references failed: ${error}`);
    }
  }

  /**
   * Build summary statistics for field references
   */
  private buildFieldReferenceSummary(references: ALFieldReference[]) {
    const byReferenceType: Record<string, number> = {};
    const bySourceType: Record<string, number> = {};
    const byPackage: Record<string, number> = {};

    for (const ref of references) {
      // Count by reference type
      byReferenceType[ref.referenceType] = (byReferenceType[ref.referenceType] || 0) + 1;

      // Count by source object type
      bySourceType[ref.sourceObjectType] = (bySourceType[ref.sourceObjectType] || 0) + 1;

      // Count by package
      const packageName = ref.packageName || 'Unknown';
      byPackage[packageName] = (byPackage[packageName] || 0) + 1;
    }

    return {
      byReferenceType,
      bySourceType,
      byPackage
    };
  }

  /**
   * Load AL packages from specified path
   */
  async loadPackages(args: LoadPackagesArgs): Promise<LoadPackagesResult> {
    try {
      // Discover packages in the specified path
      const packagePaths = await this.packageManager.discoverPackages({
        packagesPath: args.packagesPath,
        recursive: true
      });

      if (packagePaths.length === 0) {
        throw new Error(`No AL packages found in ${args.packagesPath}`);
      }

      // Load the packages
      const result = await this.packageManager.loadPackages(
        packagePaths,
        args.forceReload || false
      );

      return result;
    } catch (error) {
      throw new Error(`Load packages failed: ${error}`);
    }
  }

  /**
   * List currently loaded packages
   */
  async listPackages(): Promise<ListPackagesResult> {
    try {
      const packages = this.packageManager.getLoadedPackages();
      
      return {
        packages,
        totalCount: packages.length
      };
    } catch (error) {
      throw new Error(`List packages failed: ${error}`);
    }
  }

  /**
   * Auto-discover .alpackages directories
   */
  async autoDiscoverPackages(rootPath: string): Promise<LoadPackagesResult> {
    try {
      // Find all .alpackages directories
      const packageDirs = await this.packageManager.autoDiscoverPackageDirectories(rootPath);
      
      if (packageDirs.length === 0) {
        throw new Error(`No .alpackages directories found under ${rootPath}`);
      }

      // Discover and load packages from all found directories
      const allPackagePaths: string[] = [];
      
      for (const packageDir of packageDirs) {
        const packages = await this.packageManager.discoverPackages({
          packagesPath: packageDir,
          recursive: false
        });
        allPackagePaths.push(...packages);
      }

      if (allPackagePaths.length === 0) {
        throw new Error('No AL packages found in discovered .alpackages directories');
      }

      // Resolve dependency order and load packages
      const orderedPackages = await this.packageManager.resolveDependencyOrder(allPackagePaths);
      const result = await this.packageManager.loadPackages(orderedPackages);

      return result;
    } catch (error) {
      throw new Error(`Auto-discover packages failed: ${error}`);
    }
  }


  /**
   * Get database statistics
   */
  async getDatabaseStats(): Promise<{
    totalObjects: number;
    objectsByType: Record<string, number>;
    packages: number;
    lastIndexTime: number;
  }> {
    const stats = this.database.getStatistics();
    
    // Convert Map to Record for JSON serialization
    const objectsByType: Record<string, number> = {};
    for (const [type, count] of stats.objectsByType) {
      objectsByType[type] = count;
    }

    return {
      totalObjects: stats.totalObjects,
      objectsByType,
      packages: stats.packages,
      lastIndexTime: stats.lastIndexTime
    };
  }

  /**
   * Search objects by business domain
   */
  async searchByDomain(domain: string, objectTypes?: string[]): Promise<SearchObjectsResult> {
    const startTime = Date.now();
    
    try {
      // Define domain keywords
      const domainKeywords: Record<string, string[]> = {
        'Sales': ['customer', 'sales', 'invoice', 'order', 'quote', 'shipment'],
        'Purchasing': ['vendor', 'purchase', 'receipt', 'order'],
        'Finance': ['gl', 'ledger', 'account', 'balance', 'journal', 'posting'],
        'Inventory': ['item', 'inventory', 'stock', 'warehouse', 'location'],
        'Manufacturing': ['production', 'bom', 'routing', 'capacity', 'work center'],
        'Service': ['service', 'contract', 'resource', 'allocation']
      };

      const keywords = domainKeywords[domain] || [domain.toLowerCase()];
      
      // Search for objects containing domain keywords
      let allObjects = this.database.getAllObjects();
      
      // Filter by object types if specified
      if (objectTypes && objectTypes.length > 0) {
        allObjects = allObjects.filter(obj => objectTypes.includes(obj.Type));
      }
      
      // Filter by domain keywords
      const domainObjects = allObjects.filter(obj => {
        const objectName = obj.Name.toLowerCase();
        return keywords.some(keyword => objectName.includes(keyword));
      });

      const executionTime = Date.now() - startTime;

      return {
        objects: domainObjects.slice(0, 20), // Apply default limit
        totalFound: domainObjects.length,
        returned: Math.min(domainObjects.length, 20),
        offset: 0,
        limit: 20,
        hasMore: domainObjects.length > 20,
        summaryMode: true,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search by domain failed: ${error}`);
    }
  }

  /**
   * Get object extensions (page extensions, table extensions, etc.)
   */
  async getObjectExtensions(baseObjectName: string): Promise<SearchObjectsResult> {
    const startTime = Date.now();
    
    try {
      const extensions = this.database.getExtensions(baseObjectName);

      const executionTime = Date.now() - startTime;

      return {
        objects: extensions.slice(0, 20), // Apply default limit
        totalFound: extensions.length,
        returned: Math.min(extensions.length, 20),
        offset: 0,
        limit: 20,
        hasMore: extensions.length > 20,
        summaryMode: true,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Get object extensions failed: ${error}`);
    }
  }

  /**
   * Resolve an object name to a single object for member lookups. Prefers base
   * objects over same-named extensions; an explicit objectType still wins.
   */
  private resolveTarget(objectName: string, objectType?: string, packageName?: string) {
    const preference = objectType
      ? [objectType]
      : ['Table', 'Page', 'Codeunit', 'Report', 'Query', 'XmlPort',
         'TableExtension', 'PageExtension', 'ReportExtension'];
    return this.database.resolveObjectByName(objectName, preference, packageName);
  }

  /**
   * Unified search for object members (procedures, fields, controls, dataitems)
   */
  async searchObjectMembers(args: {
    objectName: string;
    objectType?: string;
    memberType: 'procedures' | 'fields' | 'controls' | 'dataitems';
    pattern?: string;
    group?: string;
    packageName?: string;
    includeExtensions?: boolean;
    limit?: number;
    offset?: number;
    includeDetails?: boolean;
  }): Promise<any> {
    // Route to appropriate specialized method
    switch (args.memberType) {
      case 'procedures':
        return this.searchProcedures({
          objectName: args.objectName,
          objectType: args.objectType,
          packageName: args.packageName,
          includeExtensions: args.includeExtensions,
          procedurePattern: args.pattern,
          limit: args.limit,
          offset: args.offset,
          includeDetails: args.includeDetails,
        });
      case 'fields':
        return this.searchFields({
          objectName: args.objectName,
          objectType: args.objectType,
          packageName: args.packageName,
          includeExtensions: args.includeExtensions,
          fieldPattern: args.pattern,
          limit: args.limit,
          offset: args.offset,
          includeDetails: args.includeDetails,
        });
      case 'controls':
        return this.searchControls({
          objectName: args.objectName,
          controlPattern: args.pattern,
          group: args.group,
          limit: args.limit,
          offset: args.offset,
          includeDetails: args.includeDetails,
        });
      case 'dataitems':
        return this.searchDataItems({
          objectName: args.objectName,
          dataItemPattern: args.pattern,
          limit: args.limit,
          offset: args.offset,
          includeDetails: args.includeDetails,
        });
      default:
        throw new Error(`Unknown member type: ${args.memberType}`);
    }
  }

  /**
   * Search procedures within a specific object
   */
  async searchProcedures(args: SearchProceduresArgs): Promise<SearchProceduresResult> {
    const startTime = Date.now();
    
    try {
      const limit = args.limit || 20;
      const offset = args.offset || 0;
      const includeDetails = args.includeDetails !== false;
      
      // Find the object first. Prefer the base object over a same-named extension.
      const targetObject = this.resolveTarget(args.objectName, args.objectType, args.packageName);

      if (!targetObject) {
        throw new Error(`Object not found: ${args.objectName}`);
      }

      // Get all procedures for the object, optionally including its extensions'
      let allProcedures = args.includeExtensions
        ? this.database.getMergedMembers<any>(targetObject, 'procedures')
        : this.database.getObjectProceduresFor(targetObject);
      
      // Filter by pattern if provided
      if (args.procedurePattern) {
        const pattern = args.procedurePattern.toLowerCase();
        const isWildcard = pattern.includes('*');
        
        if (isWildcard) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          allProcedures = allProcedures.filter(proc => 
            regex.test(proc.Name.toLowerCase())
          );
        } else {
          allProcedures = allProcedures.filter(proc => 
            proc.Name.toLowerCase().includes(pattern)
          );
        }
      }

      // Apply pagination
      const totalFound = allProcedures.length;
      const paginatedProcedures = allProcedures.slice(offset, offset + limit);

      // Optionally strip details to save tokens
      const procedures = paginatedProcedures.map(proc => {
        if (!includeDetails) {
          // Return minimal info, but never drop provenance
          const minimal: any = { Name: proc.Name };
          if (proc.SourcePackageName) {
            minimal.SourcePackageName = proc.SourcePackageName;
          }
          if (proc.SourceObjectName) {
            minimal.SourceObjectName = proc.SourceObjectName;
          }
          if (proc.SourceObjectType) {
            minimal.SourceObjectType = proc.SourceObjectType;
          }
          return minimal;
        }
        return proc;
      });

      const executionTime = Date.now() - startTime;

      const contributingPackages = args.includeExtensions
        ? Array.from(new Set(allProcedures
            .map((p: any) => p.SourcePackageName).filter(Boolean))) as string[]
        : this.database.getContributingPackages(targetObject);

      return {
        objectName: args.objectName,
        objectType: targetObject.Type,
        packageName: targetObject.PackageName,
        ...(contributingPackages.length ? { contributingPackages } : {}),
        procedures,
        totalFound,
        returned: procedures.length,
        offset,
        limit,
        hasMore: offset + limit < totalFound,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search procedures failed: ${error}`);
    }
  }

  /**
   * Search fields within a specific table
   */
  async searchFields(args: SearchFieldsArgs): Promise<SearchFieldsResult> {
    const startTime = Date.now();
    
    try {
      // Check if database has packages loaded
      const dbCheck = this.checkDatabaseLoaded();
      if (dbCheck.isEmpty) {
        throw new Error(dbCheck.message!);
      }

      const limit = args.limit || 20;
      const offset = args.offset || 0;
      const includeDetails = args.includeDetails !== false;
      
      // Find the table. An explicit objectType wins; otherwise prefer the base
      // table over a same-named table extension.
      const targetTable = this.database.resolveObjectByName(
        args.objectName,
        args.objectType ? [args.objectType] : ['Table', 'TableExtension'],
        args.packageName);

      if (!targetTable) {
        throw new Error(`Table or TableExtension not found: ${args.objectName}`);
      }

      // Get all fields for the table, optionally including its extensions'
      let allFields = args.includeExtensions
        ? this.database.getMergedMembers<any>(targetTable, 'fields')
        : this.database.getObjectFields(targetTable);
      
      // Filter by pattern if provided
      if (args.fieldPattern) {
        const pattern = args.fieldPattern.toLowerCase();
        const isWildcard = pattern.includes('*');
        
        if (isWildcard) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          allFields = allFields.filter(field => 
            regex.test(field.Name.toLowerCase())
          );
        } else {
          allFields = allFields.filter(field => 
            field.Name.toLowerCase().includes(pattern)
          );
        }
      }

      // Apply pagination
      const totalFound = allFields.length;
      const paginatedFields = allFields.slice(offset, offset + limit);

      // Optionally strip details to save tokens
      const fields = paginatedFields.map(field => {
        if (!includeDetails) {
          // Return minimal info, but never drop provenance
          const minimal: any = {
            Id: field.Id,
            Name: field.Name,
            TypeDefinition: field.TypeDefinition
          };
          if (field.SourcePackageName) {
            minimal.SourcePackageName = field.SourcePackageName;
          }
          if (field.SourceObjectName) {
            minimal.SourceObjectName = field.SourceObjectName;
          }
          if (field.SourceObjectType) {
            minimal.SourceObjectType = field.SourceObjectType;
          }
          return minimal;
        }
        return field;
      });

      const executionTime = Date.now() - startTime;

      const contributingPackages = args.includeExtensions
        ? Array.from(new Set(allFields
            .map((f: any) => f.SourcePackageName).filter(Boolean))) as string[]
        : this.database.getContributingPackages(targetTable);

      return {
        objectName: args.objectName,
        objectType: targetTable.Type,
        packageName: targetTable.PackageName,
        ...(contributingPackages.length ? { contributingPackages } : {}),
        fields,
        totalFound,
        returned: fields.length,
        offset,
        limit,
        hasMore: offset + limit < totalFound,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search fields failed: ${error}`);
    }
  }

  /**
   * Recursively collect controls from a nested control tree, tracking the path to each control.
   */
  private flattenControlsWithPath(controls: any[], path: string[], results: { control: any; path: string[] }[]): void {
    for (const control of controls) {
      const name = control.Name || '';
      const currentPath = [...path, name];
      results.push({ control, path: currentPath });
      if (control.Controls && control.Controls.length > 0) {
        this.flattenControlsWithPath(control.Controls, currentPath, results);
      }
    }
  }

  /**
   * Find a specific group subtree by name in nested controls.
   */
  private findGroupSubtree(controls: any[], groupName: string): any[] | null {
    const lowerGroup = groupName.toLowerCase();
    for (const control of controls) {
      if (control.Name && control.Name.toLowerCase() === lowerGroup && control.Controls) {
        return control.Controls;
      }
      if (control.Controls) {
        const found = this.findGroupSubtree(control.Controls, groupName);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Build a regex from a wildcard pattern, escaping special regex characters first.
   */
  private buildWildcardRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped.replace(/\*/g, '.*'));
  }

  /**
   * Search controls within a specific page, with recursive nested search and path tracking.
   */
  async searchControls(args: SearchControlsArgs & { group?: string }): Promise<SearchControlsResult> {
    const startTime = Date.now();

    try {
      const limit = args.limit || 20;
      const offset = args.offset || 0;
      const includeDetails = args.includeDetails !== false;

      // Find the page
      const objects = this.database.searchObjects(args.objectName);
      const targetPage = objects.find(obj => obj.Name === args.objectName && (obj.Type === 'Page' || obj.Type === 'PageExtension'));

      if (!targetPage) {
        throw new Error(`Page or PageExtension not found: ${args.objectName}`);
      }

      // Get top-level controls for the page
      let rootControls = this.database.getPageControls(targetPage.Name);

      // If group filter is specified, narrow to that subtree first
      if (args.group) {
        const subtree = this.findGroupSubtree(rootControls, args.group);
        if (!subtree) {
          return {
            objectName: args.objectName,
            objectType: 'Page',
            controls: [],
            totalFound: 0,
            returned: 0,
            offset,
            limit,
            hasMore: false,
            executionTimeMs: Date.now() - startTime
          };
        }
        rootControls = subtree;
      }

      // Flatten the control tree recursively, tracking paths
      const flatControls: { control: any; path: string[] }[] = [];
      const basePath = args.group ? [args.group] : [];
      this.flattenControlsWithPath(rootControls, basePath, flatControls);

      // Filter by pattern if provided
      let filtered = flatControls;
      if (args.controlPattern) {
        const pattern = args.controlPattern.toLowerCase();
        const isWildcard = pattern.includes('*');

        if (isWildcard) {
          const regex = this.buildWildcardRegex(pattern);
          filtered = flatControls.filter(entry =>
            entry.control.Name && regex.test(entry.control.Name.toLowerCase())
          );
        } else {
          filtered = flatControls.filter(entry =>
            entry.control.Name && entry.control.Name.toLowerCase().includes(pattern)
          );
        }
      }

      // Apply pagination
      const totalFound = filtered.length;
      const paginated = filtered.slice(offset, offset + limit);

      // Build result with path info
      const controls = paginated.map(entry => {
        if (!includeDetails) {
          return {
            Name: entry.control.Name,
            Kind: entry.control.Kind,
            Path: entry.path,
          };
        }
        return {
          ...entry.control,
          Path: entry.path,
          // Strip nested Controls from results to reduce token usage
          Controls: undefined,
        };
      });

      const executionTime = Date.now() - startTime;

      return {
        objectName: args.objectName,
        objectType: 'Page',
        controls,
        totalFound,
        returned: controls.length,
        offset,
        limit,
        hasMore: offset + limit < totalFound,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search controls failed: ${error}`);
    }
  }

  /**
   * Search data items within reports, queries, or xmlports
   */
  async searchDataItems(args: SearchDataItemsArgs): Promise<SearchDataItemsResult> {
    const startTime = Date.now();
    
    try {
      const limit = args.limit || 20;
      const offset = args.offset || 0;
      const includeDetails = args.includeDetails !== false;
      
      // Find the object (Report, Query, or XmlPort)
      const objects = this.database.searchObjects(args.objectName);
      const targetObject = objects.find(obj =>
        obj.Name === args.objectName &&
        ['Report', 'ReportExtension', 'Query', 'XmlPort'].includes(obj.Type)
      );

      if (!targetObject) {
        throw new Error(`Report/ReportExtension/Query/XmlPort not found: ${args.objectName}`);
      }

      // Get all data items for the object
      let allDataItems = this.database.getDataItems(targetObject.Name);
      
      // Filter by pattern if provided
      if (args.dataItemPattern) {
        const pattern = args.dataItemPattern.toLowerCase();
        const isWildcard = pattern.includes('*');
        
        if (isWildcard) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          allDataItems = allDataItems.filter(item => 
            item.Name && regex.test(item.Name.toLowerCase())
          );
        } else {
          allDataItems = allDataItems.filter(item => 
            item.Name && item.Name.toLowerCase().includes(pattern)
          );
        }
      }

      // Apply pagination
      const totalFound = allDataItems.length;
      const paginatedItems = allDataItems.slice(offset, offset + limit);

      // Optionally strip details to save tokens
      const dataItems = paginatedItems.map(item => {
        if (!includeDetails) {
          // Return minimal info
          return {
            Name: item.Name,
            DataItemTable: item.DataItemTable || item.SourceTable,
            NodeType: item.NodeType
          };
        }
        return item;
      });

      const executionTime = Date.now() - startTime;

      return {
        objectName: args.objectName,
        objectType: targetObject.Type,
        dataItems,
        totalFound,
        returned: dataItems.length,
        offset,
        limit,
        hasMore: offset + limit < totalFound,
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Search data items failed: ${error}`);
    }
  }

  /**
   * Get intelligent summary of an object with smart procedure categorization
   */
  async getObjectSummary(objectName: string, objectType?: string): Promise<{
    object: any;
    summary: {
      name: string;
      type: string;
      totalProcedures: number;
      procedureCategories: {
        [category: string]: {
          count: number;
          examples: string[];
        };
      };
      keyProcedures: string[];
      description: string;
    };
    executionTimeMs: number;
  }> {
    const startTime = Date.now();

    try {
      // Find the object. Prefer the base object over a same-named extension.
      const targetObject = this.resolveTarget(objectName, objectType);

      if (!targetObject) {
        throw new Error(`Object not found: ${objectName}`);
      }

      // Get procedures
      const allProcedures = this.database.getObjectProceduresFor(targetObject);
      
      // Categorize procedures using attributes (accurate) and naming patterns (fallback)
      const categories: { [key: string]: { count: number; examples: string[] } } = {};
      const keyProcedures: string[] = [];

      // Helper to add to category
      const addToCategory = (categoryName: string, procName: string) => {
        if (!categories[categoryName]) {
          categories[categoryName] = { count: 0, examples: [] };
        }
        categories[categoryName].count++;
        if (categories[categoryName].examples.length < 5) {
          categories[categoryName].examples.push(procName);
        }
      };

      // Name-based patterns (fallback when no attributes)
      const categoryPatterns = {
        'Main Entry Points': /^(Run|Execute|Process|Main|Start)/i,
        'Validation & Checks': /^(Check|Validate|Test|Verify|Ensure)/i,
        'Posting Operations': /^(Post|Create|Insert|Update|Delete|Modify)/i,
        'Data Processing': /^(Fill|Refresh|Reset|Copy|Transfer|Calculate|Build)/i,
        'Event Handlers': /^(On[A-Z]|Before|After)/i,
        'Getters & Utilities': /^(Get|Find|Lookup|Set|Init)/i,
        'Error Handling': /^(Error|Exception|Handle|Raise)/i
      };

      // Categorize each procedure
      for (const proc of allProcedures) {
        let categorized = false;

        // First: attribute-based categorization (most accurate)
        if (proc.Attributes && proc.Attributes.length > 0) {
          const attrNames = proc.Attributes.map((a: any) => a.Name);

          if (attrNames.includes('IntegrationEvent') || attrNames.includes('BusinessEvent') || attrNames.includes('InternalEvent')) {
            addToCategory('Event Publishers', proc.Name);
            categorized = true;
          } else if (attrNames.includes('EventSubscriber')) {
            addToCategory('Event Subscribers', proc.Name);
            categorized = true;
          } else if (attrNames.includes('Obsolete')) {
            addToCategory('Obsolete (deprecated)', proc.Name);
            categorized = true;
          }
        }

        // Fallback: name-based categorization
        if (!categorized) {
          for (const [categoryName, pattern] of Object.entries(categoryPatterns)) {
            if (pattern.test(proc.Name)) {
              addToCategory(categoryName, proc.Name);
              categorized = true;
              break;
            }
          }
        }

        // If still not categorized, put in "Other"
        if (!categorized) {
          addToCategory('Other Functions', proc.Name);
        }

        // Identify key procedures (likely entry points)
        if (/^(Run|Execute|Process|Main|Check.*Document|Post.*Line)$/i.test(proc.Name)) {
          keyProcedures.push(proc.Name);
        }
      }

      // Generate intelligent description
      let description = `The ${targetObject.Name} ${targetObject.Type.toLowerCase()}`;
      if (targetObject.Type === 'Codeunit') {
        description += ` has ${allProcedures.length} procedures covering`;
        const topCategories = Object.entries(categories)
          .sort(([,a], [,b]) => b.count - a.count)
          .slice(0, 3)
          .map(([name]) => name.toLowerCase());
        description += ` ${topCategories.join(', ')}`;
        
        if (targetObject.Name.includes('Post')) {
          description += ', focused on posting operations';
        }
      }

      const executionTime = Date.now() - startTime;

      return {
        object: {
          Name: targetObject.Name,
          Type: targetObject.Type,
          Id: targetObject.Id,
          PackageName: targetObject.PackageName
        },
        summary: {
          name: targetObject.Name,
          type: targetObject.Type,
          totalProcedures: allProcedures.length,
          procedureCategories: categories,
          keyProcedures: keyProcedures.slice(0, 10), // Max 10 key procedures
          description
        },
        executionTimeMs: executionTime
      };
    } catch (error) {
      throw new Error(`Get object summary failed: ${error}`);
    }
  }

  /**
   * Resolve a ReferenceSourceFileName to an actual file path on disk.
   */
  private resolveSourceFile(refPath: string): string | null {
    if (!refPath || this.sourcePaths.length === 0) return null;
    const decoded = decodeURIComponent(refPath);
    for (const srcRoot of this.sourcePaths) {
      const fullPath = path.join(srcRoot, decoded);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return null;
  }

  /**
   * Extract a procedure or trigger body from AL source by name.
   * Finds the declaration line and extracts until the matching end block.
   */
  private extractProcedureFromSource(lines: string[], memberName: string): { snippet: string; startLine: number; endLine: number } | null {
    const lowerName = memberName.toLowerCase();
    let startIdx = -1;

    // Find the procedure/trigger declaration
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase().trim();
      if (
        (lower.includes('procedure') && lower.includes(lowerName)) ||
        (lower.startsWith('trigger') && lower.includes(lowerName))
      ) {
        // Check for attributes on preceding lines
        startIdx = i;
        while (startIdx > 0 && lines[startIdx - 1].trim().startsWith('[')) {
          startIdx--;
        }
        break;
      }
    }

    if (startIdx === -1) return null;

    // Find the end of the procedure by tracking begin/end depth
    let depth = 0;
    let foundBegin = false;
    let endIdx = startIdx;

    for (let i = startIdx; i < lines.length; i++) {
      const trimmed = lines[i].trim().toLowerCase();

      // Count begin/end blocks (simplified — handles most AL patterns)
      const beginMatches = trimmed.match(/\bbegin\b/g);
      const endMatches = trimmed.match(/\bend\b/g);

      if (beginMatches) {
        depth += beginMatches.length;
        foundBegin = true;
      }
      if (endMatches) {
        depth -= endMatches.length;
      }

      if (foundBegin && depth <= 0) {
        endIdx = i;
        break;
      }

      // Safety: if we hit another procedure declaration, stop
      if (i > startIdx + 2 && !foundBegin) {
        const nextTrimmed = lines[i].trim().toLowerCase();
        if (nextTrimmed.startsWith('procedure ') || nextTrimmed.startsWith('local procedure ') ||
            nextTrimmed.startsWith('internal procedure ') || nextTrimmed.startsWith('trigger ')) {
          endIdx = i - 1;
          break;
        }
      }
    }

    return {
      snippet: lines.slice(startIdx, endIdx + 1).join('\n'),
      startLine: startIdx + 1,
      endLine: endIdx + 1,
    };
  }

  /**
   * Extract a field declaration from AL source by name.
   */
  private extractFieldFromSource(lines: string[], memberName: string): { snippet: string; startLine: number; endLine: number } | null {
    const lowerName = memberName.toLowerCase();
    let startIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      // Match field(ID; "Name"; Type) or field(ID; Name; Type)
      if (lower.includes('field(') && lower.includes(lowerName)) {
        startIdx = i;
        break;
      }
    }

    if (startIdx === -1) return null;

    // Find the closing brace of the field block
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth <= 0 && i > startIdx) {
        endIdx = i;
        break;
      }
    }

    return {
      snippet: lines.slice(startIdx, endIdx + 1).join('\n'),
      startLine: startIdx + 1,
      endLine: endIdx + 1,
    };
  }

  /**
   * Get a source code snippet for an AL object or a specific member within it.
   */
  async getSourceSnippet(args: {
    objectName: string;
    objectType?: string;
    memberName?: string;
    memberType?: 'procedure' | 'trigger' | 'field' | 'control';
  }): Promise<{
    objectName: string;
    filePath: string;
    snippet: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    executionTimeMs: number;
  }> {
    const startTime = Date.now();

    if (this.sourcePaths.length === 0) {
      throw new Error('Source lookup not available. Set AL_SOURCE_PATH environment variable to a folder containing BC base app .al source files.');
    }

    // Find the object in the symbol database
    const target = this.resolveTarget(args.objectName, args.objectType);

    if (!target) {
      throw new Error(`Object not found: ${args.objectName}`);
    }

    // An object split across packages by a move has one source reference per
    // declaration; only some of those packages have their sources on disk. Try each.
    const declarations = this.database.getDeclarations(target);
    const references = declarations
      .map(decl => decl.ReferenceSourceFileName)
      .filter((ref): ref is string => !!ref);

    if (references.length === 0) {
      throw new Error(`No source file reference for: ${args.objectName}`);
    }

    let filePath: string | null = null;
    let usedReference = references[0];
    for (const reference of references) {
      const candidate = this.resolveSourceFile(reference);
      if (candidate) {
        filePath = candidate;
        usedReference = reference;
        break;
      }
    }

    if (!filePath) {
      throw new Error(`Source file not found: ${references.join(' | ')} (searched in: ${this.sourcePaths.join(', ')})`);
    }


    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // If no member requested, return a summary (first 50 lines + last 5)
    if (!args.memberName) {
      const maxLines = 50;
      let snippet: string;
      let startLine = 1;
      let endLine: number;

      if (lines.length <= maxLines) {
        snippet = content;
        endLine = lines.length;
      } else {
        snippet = lines.slice(0, maxLines).join('\n') + `\n\n// ... ${lines.length - maxLines} more lines ...`;
        endLine = maxLines;
      }

      return {
        objectName: args.objectName,
        filePath: usedReference,
        snippet,
        startLine,
        endLine,
        totalLines: lines.length,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Extract specific member
    const mType = args.memberType || 'procedure';
    let result: { snippet: string; startLine: number; endLine: number } | null = null;

    if (mType === 'procedure' || mType === 'trigger') {
      result = this.extractProcedureFromSource(lines, args.memberName);
    } else if (mType === 'field') {
      result = this.extractFieldFromSource(lines, args.memberName);
    } else if (mType === 'control') {
      // Controls use the same brace-counting approach as fields
      result = this.extractFieldFromSource(lines, args.memberName);
    }

    if (!result) {
      throw new Error(`Member "${args.memberName}" not found in ${usedReference}`);
    }

    return {
      objectName: args.objectName,
      filePath: usedReference,
      snippet: result.snippet,
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: lines.length,
      executionTimeMs: Date.now() - startTime,
    };
  }
}