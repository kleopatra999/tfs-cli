import { ManifestBuilder } from "./manifest";
import { FileDeclaration, PackageFiles, ResourcesFile, ScreenshotDeclaration, TargetDeclaration, Vsix, VsixLanguagePack } from "./interfaces";
import { cleanAssetPath, jsonToXml, maxKey, removeMetaKeys, toZipItemName } from "./utils";
import _ = require("lodash");
import childProcess = require("child_process");
import onecolor = require("onecolor");
import os = require("os");
import path = require("path");
import stream = require("stream");
import trace = require("../trace");
import winreg = require("winreg");
import xml = require("xml2js");

export class VsixManifestBuilder extends ManifestBuilder {
    
    /**
     * List of known file types to use in the [Content_Types].xml file in the VSIX package.
     */
    private static CONTENT_TYPE_MAP: {[key: string]: string} = {
        ".md": "text/markdown",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".gif": "image/gif",
        ".bat": "application/bat",
        ".json": "application/json",
        ".vsixlangpack": "text/xml",
        ".vsixmanifest": "text/xml",
        ".vsomanifest": "application/json",
        ".ps1": "text/ps1"
    };
    
    private static vsixValidators: {[path: string]: (value) => string} = {
        "PackageManifest.Metadata[0].Identity[0].$.Id": (value) => {
            if (/^[A-z0-9_-]+$/.test(value)) {
                return null;
            } else {
                return "'extensionId' may only include letters, numbers, underscores, and dashes.";
            }
        },
        "PackageManifest.Metadata[0].Identity[0].$.Version": (value) => {
            if (typeof value === "string" && value.length > 0) {
                return null;
            } else {
                return "'version' must be provided.";
            }
        },
        "PackageManifest.Metadata[0].DisplayName[0]": (value) => {
            if (typeof value === "string" && value.length > 0) {
                return null;
            } else {
                return "'name' must be provided.";
            }
        },
        "PackageManifest.Assets[0].Asset": (value) => {
            let usedAssetTypes = {};
            if (_.isArray(value)) {
                for (let i = 0; i < value.length; ++i) {
                    let asset = value[i].$;
                    if (asset) {
                        if (!asset.Path) {
                            return "All 'files' must include a 'path'.";
                        }
                        if (asset.Type && asset.Addressable) {
                            if (usedAssetTypes[asset.Type]) {
                                return "Cannot have multiple 'addressable' files with the same 'assetType'.\nFile1: " + usedAssetTypes[asset.Type] + ", File 2: " + asset.Path + " (asset type: " + asset.Type + ")";
                            } else {
                                usedAssetTypes[asset.Type] = asset.Path;
                            }
                        }
                    }
                }
            }
            
            return null;
        },
        "PackageManifest.Metadata[0].Identity[0].$.Publisher": (value) => {
            if (typeof value === "string" && value.length > 0) {
                return null;
            } else {
                return "'publisher' must be provided.";
            }
        },
        "PackageManifest.Metadata[0].Categories[0]": (value) => {
            if (!value) {
                return null;
            }
            let categories = value.split(",");
            if (categories.length > 1) {
                return "For now, extensions are limited to a single category.";
            }
            let validCategories = [
                "Build and release",
                "Collaboration",
                "Customer support",
                "Planning",
                "Productivity",
                "Sync and integration",
                "Testing"
            ];
            _.remove(categories, c => !c);
            let badCategories = categories.filter(c => validCategories.indexOf(c) < 0);
            return badCategories.length ? "The following categories are not valid: " + badCategories.join(", ") + ". Valid categories are: " + validCategories.join(", ") + "." : null;
        },
        "PackageManifest.Installation[0].InstallationTarget": (value) => {
            if (_.isArray(value) && value.length > 0) {
                return null;
            }
            return "Your manifest must include at least one 'target'.";
        }
    };
    
    public static manifestType = "vsix";
    
    /**
     * Explains the type of manifest builder
     */
    public getType(): string {
        return VsixManifestBuilder.manifestType;
    }
    
    /**
     * Gets the package path to this manifest
     */
    public getPath(): string {
        return "extension.vsixmanifest";
    }
    
    /**
     * VSIX Manifest loc assets are vsixlangpack files.
     */
    public getLocPath(): string {
        return "Extension.vsixlangpack";
    }
    
    /**
     * Gets the contents of the vsixLangPack file for this manifest
     */
    public getLocResult(translations: ResourcesFile, defaults: ResourcesFile): string {
        let langPack = this.generateVsixLangPack(translations, defaults);
        return jsonToXml(langPack);
    }
    
    private generateVsixLangPack(translations: ResourcesFile, defaults: ResourcesFile): VsixLanguagePack {
        return <VsixLanguagePack>{
            VsixLanguagePack: {
                $: {
                    Version: "1.0.0",
                    xmlns: "http://schemas.microsoft.com/developer/vsx-schema-lp/2010"
                },
                LocalizedName: [translations["displayName"] || defaults["displayName"]],
                LocalizedDescription: [translations["description"] || defaults["description"]],
                LocalizedReleaseNotes: [translations["releaseNotes"] || defaults["releaseNotes"]],
                License: [null],
                MoreInfoUrl: [null]
            }
        };
    }
    
    /**
     * Add an asset: add a file to the vsix package and if there is an assetType on the
     * file, add an <Asset> entry in the vsixmanifest.
     */
    private addAsset(file: FileDeclaration) {
        this.addFile(file);
    }
    
    /**
     * Add an <Asset> entry to the vsixmanifest.
     */
    private addAssetToManifest(assetPath: string, type: string, addressable: boolean = false, lang: string = null): void {
        let cleanAssetPath = toZipItemName(assetPath);
        let asset = {
            "Type": type,
            "d:Source": "File",
            "Path": cleanAssetPath
        };
        if (addressable) {
            asset["Addressable"] = "true";
        }
        if (lang) {
            asset["Lang"] = lang;
        }
        this.data.PackageManifest.Assets[0].Asset.push({
            "$": asset
        });
        
        if (type === "Microsoft.VisualStudio.Services.Icons.Default") {
            this.data.PackageManifest.Metadata[0].Icon = [cleanAssetPath];
        }
    }
    
    /**
     * Add a property to the vsixmanifest.
     */
    private addProperty(id: string, value: string) {
        let defaultProperties = [];
        let existingProperties = _.get<any[]>(this.data, "PackageManifest.Metadata[0].Properties[0].Property", defaultProperties);
        if (defaultProperties === existingProperties) {
            _.set(this.data, "PackageManifest.Metadata[0].Properties[0].Property", defaultProperties);
        }
        existingProperties.push({
            $: {
                Id: id,
                Value: value
            }
        });
    }
    
    /**
     * Given a key/value pair, decide how this effects the manifest
     */
    public processKey(key: string, value: any, override: boolean): void {
        switch(key.toLowerCase()) {
            case "namespace":
            case "extensionid":
            case "id":
                if (_.isString(value)) {
                    this.singleValueProperty("PackageManifest.Metadata[0].Identity[0].$.Id", value, "namespace/extensionId/id", override);
                }
                break;
            case "version":
                this.singleValueProperty("PackageManifest.Metadata[0].Identity[0].$.Version", value, key, override);
                break;
            case "name":
                this.singleValueProperty("PackageManifest.Metadata[0].DisplayName[0]", value, key, override);
                break;
            case "description":
                this.singleValueProperty("PackageManifest.Metadata[0].Description[0]._", value, key, override);
                break;
            case "icons":
                Object.keys(value).forEach((key) => {
                    let iconType = _.startCase(key.toLowerCase());
                    let fileDecl: FileDeclaration = {
                        path: value[key],
                        addressable: true,
                        assetType: "Microsoft.VisualStudio.Services.Icons." + iconType,
                        partName: value[key]
                    };
                    this.addAsset(fileDecl);
                });
                break;
            case "screenshots":
                if (_.isArray(value)) {
                    let screenshotIndex = 0;
                    value.forEach((screenshot: ScreenshotDeclaration) => {
                        let fileDecl: FileDeclaration = {
                            path: screenshot.path,
                            addressable: true,
                            assetType: "Microsoft.VisualStudio.Services.Screenshots." + (++screenshotIndex),
                            contentType: screenshot.contentType
                        };
                        this.addAsset(fileDecl);
                    });
                }
                break;
            case "details":
                if (_.isObject(value) && value.path) {
                    let fileDecl: FileDeclaration = {
                        path: value.path,
                        addressable: true,
                        assetType: "Microsoft.VisualStudio.Services.Content.Details",
                        contentType: value.contentType
                    };
                    this.addAsset(fileDecl);
                }
                break;
            case "targets": 
                if (_.isArray(value)) {
                    let existingTargets = _.get<any[]>(this.data, "PackageManifest.Installation[0].InstallationTarget", []);
                    value.forEach((target: TargetDeclaration) => {
                        if (!target.id) {
                            return;
                        }
                        let newTargetAttrs = {
                            Id: target.id
                        };
                        if (target.version) {
                            newTargetAttrs["Version"] = target.version;
                        }
                        existingTargets.push({
                            $: newTargetAttrs
                        });
                    });
                }
                break;
            case "links": 
                if (_.isObject(value)) {
                    Object.keys(value).forEach((linkType) => {
                        let url = _.get<string>(value, linkType + ".uri") || _.get<string>(value, linkType + ".url");
                        if (url) {
                            let linkTypeCased = _.capitalize(_.camelCase(linkType));
                            this.addProperty("Microsoft.VisualStudio.Services.Links." + linkTypeCased, url);
                        } else {
                            trace.warn("'uri' property not found for link: '%s'... ignoring.", linkType);
                        }
                    });
                }
                break;
            case "branding":
                if (_.isObject(value)) {
                    Object.keys(value).forEach((brandingType) => {
                        let brandingTypeCased = _.capitalize(_.camelCase(brandingType));
                        let brandingValue = value[brandingType];
                        if (brandingTypeCased === "Color") {
                            try {
                                brandingValue = onecolor(brandingValue).hex();
                            } catch (e) {
                                throw "Could not parse branding color as a valid color. Please use a hex or rgb format, e.g. #00ff00 or rgb(0, 255, 0)";
                            }
                        }
                        this.addProperty("Microsoft.VisualStudio.Services.Branding." + brandingTypeCased, brandingValue);
                    });
                }
                break;
            case "public": 
                if (typeof value === "boolean") {
                    let flags = _.get(this.data, "PackageManifest.Metadata[0].GalleryFlags[0]", "").split(",");
                    _.remove(flags, v => v === "");
                    if (value === true) {
                        flags.push("Public");
                    }
                    _.set(this.data, "PackageManifest.Metadata[0].GalleryFlags[0]", _.uniq(flags).join(","));
                }
                break;
            case "publisher":
                this.singleValueProperty("PackageManifest.Metadata[0].Identity[0].$.Publisher", value, key, override);
                break;
            case "releasenotes":
                this.singleValueProperty("PackageManifest.Metadata[0].ReleaseNotes[0]", value, key, override);
                break;
            case "tags":
                this.handleDelimitedList(value, "PackageManifest.Metadata[0].Tags[0]");
                break;
            case "flags":
            case "vsoflags":
            case "galleryflags":
                // Gallery Flags are space-separated since it's a Flags enum.
                this.handleDelimitedList(value, "PackageManifest.Metadata[0].GalleryFlags[0]", " ", true);
                break;
            case "categories":
                this.handleDelimitedList(value, "PackageManifest.Metadata[0].Categories[0]");
                break;
            case "files": 
                if (_.isArray(value)) {
                    value.forEach((asset: FileDeclaration) => {
                        this.addAsset(asset);
                    });
                }
                break;
        }
    }
    
    /**
     * Return a string[] of current validation errors
     */
    public validate(): Q.Promise<string[]> {
        return Q.resolve(Object.keys(VsixManifestBuilder.vsixValidators).map(path => VsixManifestBuilder.vsixValidators[path](_.get(this.data, path))).filter(r => !!r));
    }
    
    /**
     * --Ensures an <Asset> entry is added for each file as appropriate
     * --Builds the [Content_Types].xml file
     */
    public finalize(files: PackageFiles): Q.Promise<void> {
        Object.keys(files).forEach((fileName) => {
            let file = files[fileName];
            
            // Add all assets to manifest except the vsixmanifest (duh)
            if (file.assetType && file.path !== this.getPath()) {
                this.addAssetToManifest(file.path, file.assetType, file.addressable, file.lang);
            }
        });
        // The vsixmanifest will be responsible for generating the [Content_Types].xml file
        // Obviously this is kind of strange, but hey ho.
        return this.genContentTypesXml().then((result) => {
            this.addFile({
                path: null,
                content: result,
                partName: "[Content_Types].xml"
            });
        });
    }
    
    /**
     * Gets the string representation (XML) of this manifest
     */
    public getResult(): string {
        return jsonToXml(removeMetaKeys(this.data)).replace(/\n/g, os.EOL);
    }
    
    /**
     * Generates the required [Content_Types].xml file for the vsix package.
     * This xml contains a <Default> entry for each different file extension
     * found in the package, mapping it to the appropriate MIME type.
     */
    private genContentTypesXml(): Q.Promise<string> {
        let typeMap = VsixManifestBuilder.CONTENT_TYPE_MAP;
        trace.debug("Generating [Content_Types].xml");
        let contentTypes: any = {
            Types: {
                $: {
                    xmlns: "http://schemas.openxmlformats.org/package/2006/content-types"
                },
                Default: [],
                Override: []
            }
        };
        let windows = /^win/.test(process.platform);
        let contentTypePromise;
        if (windows) {
            // On windows, check HKCR to get the content type of the file based on the extension
            let contentTypePromises: Q.Promise<any>[] = [];
            let extensionlessFiles = [];
            let uniqueExtensions = _.unique<string>(Object.keys(this.files).map((f) => {
                let extName = path.extname(f);
                if (!extName && !this.files[f].contentType) {
                    trace.warn("File %s does not have an extension, and its content-type is not declared. Defaulting to application/octet-stream.", path.resolve(f));
                }
                if (this.files[f].contentType) {
                    // If there is an override for this file, ignore its extension
                    return "";
                }
                return extName;
            }));
            uniqueExtensions.forEach((ext) => {
                if (!ext.trim()) {
                    return;
                }
                if (!ext) {
                    return;
                }
                if (typeMap[ext.toLowerCase()]) {
                    contentTypes.Types.Default.push({
                        $: {
                            Extension: ext,
                            ContentType: typeMap[ext.toLowerCase()]
                        }
                    });
                    return;
                }
                let hkcrKey = new winreg({
                    hive: winreg.HKCR,
                    key: "\\" + ext.toLowerCase()
                });
                let regPromise = Q.ninvoke(hkcrKey, "get", "Content Type").then((type: WinregValue) => {
                    trace.debug("Found content type for %s: %s.", ext, type.value);
                    let contentType = "application/octet-stream";
                    if (type) {
                        contentType = type.value;
                    }
                    return contentType;
                }).catch((err) => {
                    trace.warn("Could not determine content type for extension %s. Defaulting to application/octet-stream. To override this, add a contentType property to this file entry in the manifest.", ext);
                    return "application/octet-stream";
                }).then((contentType) => {
                    contentTypes.Types.Default.push({
                        $: {
                            Extension: ext,
                            ContentType: contentType
                        }
                    });
                });
                contentTypePromises.push(regPromise);
            });
            contentTypePromise = Q.all(contentTypePromises);
        } else {
            // If not on windows, run the file --mime-type command to use magic to get the content type.
            // If the file has an extension, rev a hit counter for that extension and the extension
            // If there is no extension, create an <Override> element for the element
            // For each file with an extension that doesn't match the most common type for that extension
            // (tracked by the hit counter), create an <Override> element.
            // Finally, add a <Default> element for each extension mapped to the most common type.
            
            let contentTypePromises: Q.Promise<any>[] = [];
            let extTypeCounter: {[ext: string]: {[type: string]: string[]}} = {};
            Object.keys(this.files).forEach((fileName) => {
                let extension = path.extname(fileName);
                let mimePromise;
                if (typeMap[extension]) {
                    if (!extTypeCounter[extension]) {
                        extTypeCounter[extension] = {};
                    }
                    if (!extTypeCounter[extension][typeMap[extension]]) {
                        extTypeCounter[extension][typeMap[extension]] = [];
                    }
                    extTypeCounter[extension][typeMap[extension]].push(fileName);
                    mimePromise = Q.resolve(null);
                    return;
                }
                mimePromise = Q.Promise((resolve, reject, notify) => {
                    let child = childProcess.exec("file --mime-type \"" + fileName + "\"", (err, stdout, stderr) => {
                        try {
                            if (err) {
                                reject(err);
                            }
                            let stdoutStr = stdout.toString("utf8");
                            let magicMime = _.trimRight(stdoutStr.substr(stdoutStr.lastIndexOf(" ") + 1), "\n");
                            trace.debug("Magic mime type for %s is %s.", fileName, magicMime);
                            if (magicMime) {
                                if (extension) {
                                    if (!extTypeCounter[extension]) {
                                        extTypeCounter[extension] = {};
                                    }
                                    let hitCounters = extTypeCounter[extension];
                                    if (!hitCounters[magicMime]) {
                                        hitCounters[magicMime] = [];
                                    } 
                                    hitCounters[magicMime].push(fileName);
                                } else {
                                    if (!this.files[fileName].contentType) {
                                        this.files[fileName].contentType = magicMime;
                                    }
                                }
                            } else {
                                if (stderr) {
                                    reject(stderr.toString("utf8"));
                                } else {
                                    trace.warn("Could not determine content type for %s. Defaulting to application/octet-stream. To override this, add a contentType property to this file entry in the manifest.", fileName);
                                    this.files[fileName].contentType = "application/octet-stream";
                                }
                            }
                            resolve(null);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                contentTypePromises.push(mimePromise);
            });
            contentTypePromise = Q.all(contentTypePromises).then(() => {
                Object.keys(extTypeCounter).forEach((ext) => {
                    let hitCounts = extTypeCounter[ext];
                    let bestMatch = maxKey<string[]>(hitCounts, (i => i.length));
                    Object.keys(hitCounts).forEach((type) => {
                        if (type === bestMatch) {
                            return;
                        }
                        hitCounts[type].forEach((fileName) => {
                            this.files[fileName].contentType = type;
                        });
                    });
                    contentTypes.Types.Default.push({
                        $: {
                            Extension: ext,
                            ContentType: bestMatch
                        }
                    });
                });
            });
        }
        return contentTypePromise.then(() => {
            Object.keys(this.files).forEach((partName) => {
                contentTypes.Types.Override.push({
                    $: {
                        ContentType: this.files[partName].contentType,
                        PartName: "/" + _.trimLeft(partName, "/")
                    }
                });
            });
            return jsonToXml(contentTypes).replace(/\n/g, os.EOL);
        });
    }
}