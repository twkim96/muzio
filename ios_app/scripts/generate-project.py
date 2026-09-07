#!/usr/bin/env python3
"""Dependency-free deterministic Xcode project for the shared Apple sources."""
from pathlib import Path
import hashlib, json
root = Path(__file__).resolve().parents[1]
objects = {}
def ident(name): return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def add(key_name, isa, **fields):
    key=ident(key_name); objects[key]={'isa':isa,**fields}; return key
sources=[]
for file in sorted((root/'Muzio').glob('*.swift')):
    sources.append(add('file:'+file.name,'PBXFileReference',lastKnownFileType='sourcecode.swift',path='Muzio/'+file.name,sourceTree='<group>'))
products=add('products','PBXGroup',children=[],name='Products',sourceTree='<group>')
main=add('main','PBXGroup',children=sources+[products],sourceTree='<group>')
def config_list(prefix, settings):
    configs=[]
    for name in ('Debug','Release'):
        values={**settings,'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if name=='Debug' else '-O'}
        configs.append(add(prefix+name,'XCBuildConfiguration',buildSettings=values,name=name))
    return add(prefix+'configlist','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
targets=[]
for label,sdk,plist,extra in [('Muzio-iOS','iphoneos','Info.plist',{'IPHONEOS_DEPLOYMENT_TARGET':'16.0','TARGETED_DEVICE_FAMILY':'1,2','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO'}),('Muzio-macOS','macosx','Mac-Info.plist',{'MACOSX_DEPLOYMENT_TARGET':'13.0','SUPPORTED_PLATFORMS':'macosx','ENABLE_HARDENED_RUNTIME':'YES'})]:
    files=[add(label+ref,'PBXBuildFile',fileRef=ref) for ref in sources]
    phase=add(label+'sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=files,runOnlyForDeploymentPostprocessing=0)
    product=add(label+'product','PBXFileReference',explicitFileType='wrapper.application',includeInIndex=0,path='Muzio.app',sourceTree='BUILT_PRODUCTS_DIR')
    objects[products]['children'].append(product)
    settings={'PRODUCT_NAME':'Muzio','PRODUCT_BUNDLE_IDENTIFIER':'com.twkim.muzio.apple','INFOPLIST_FILE':plist,'GENERATE_INFOPLIST_FILE':'NO','SDKROOT':sdk,'SWIFT_VERSION':'5.0','CODE_SIGN_STYLE':'Automatic','MARKETING_VERSION':'1.4.6','CURRENT_PROJECT_VERSION':'1','LD_RUNPATH_SEARCH_PATHS':'$(inherited) @executable_path/Frameworks @executable_path/../Frameworks',**extra}
    phases=[phase]
    if sdk=='iphoneos':
        settings['ASSETCATALOG_COMPILER_APPICON_NAME']='AppIcon'
        assets=add('assets','PBXFileReference',lastKnownFileType='folder.assetcatalog',path='Assets.xcassets',sourceTree='<group>')
        objects[main]['children'].append(assets)
        assetsbuild=add('assetsbuild','PBXBuildFile',fileRef=assets)
        phases.append(add('iosresources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=[assetsbuild],runOnlyForDeploymentPostprocessing=0))
    if sdk=='macosx':
        icon=add('icon','PBXFileReference',lastKnownFileType='image.icns',path='Muzio.icns',sourceTree='<group>')
        objects[main]['children'].append(icon)
        iconbuild=add('iconbuild','PBXBuildFile',fileRef=icon)
        phases.append(add('resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=[iconbuild],runOnlyForDeploymentPostprocessing=0))
    target=add(label,'PBXNativeTarget',buildConfigurationList=config_list(label,settings),buildPhases=phases,buildRules=[],dependencies=[],name=label,productName='Muzio',productReference=product,productType='com.apple.product-type.application')
    targets.append(target)
project=add('project','PBXProject',attributes={'LastUpgradeCheck':'1600'},buildConfigurationList=config_list('project',{'CLANG_ENABLE_MODULES':'YES'}),compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings=0,knownRegions=['en','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',targets=targets)
def serialize(v, level=0):
    if isinstance(v,dict): return '{\n'+''.join('\t'*(level+1)+json.dumps(str(k))+' = '+serialize(val,level+1)+';\n' for k,val in v.items())+'\t'*level+'}'
    if isinstance(v,list): return '('+', '.join(serialize(x,level) for x in v)+')'
    return str(v) if isinstance(v,int) else json.dumps(v)
path=root/'Muzio.xcodeproj';path.mkdir(exist_ok=True)
(path/'project.pbxproj').write_text('// !$*UTF8*$!\n'+serialize({'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':project})+'\n')
for name in ('Muzio-iOS','Muzio-macOS'):
    schemes=path/'xcshareddata'/'xcschemes';schemes.mkdir(parents=True,exist_ok=True)
    ref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident(name)}" BuildableName="Muzio.app" BlueprintName="{name}" ReferencedContainer="container:Muzio.xcodeproj"/>'
    (schemes/(name+'.xcscheme')).write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>
''')
print(path)
