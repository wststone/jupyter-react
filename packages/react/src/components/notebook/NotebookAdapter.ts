import { Store } from "redux";
import { CommandRegistry } from '@lumino/commands';
import { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { BoxPanel, Widget } from '@lumino/widgets';
import { IChangedArgs, PageConfig } from '@jupyterlab/coreutils';
import { Cell, ICellModel, CodeCellModel, MarkdownCellModel, RawCellModel, MarkdownCell } from '@jupyterlab/cells';
import { ServiceManager, Kernel as JupyterKernel } from '@jupyterlab/services';
import { DocumentRegistry, Context } from '@jupyterlab/docregistry';
import { standardRendererFactories, RenderMimeRegistry } from '@jupyterlab/rendermime';
import { rendererFactory as jsonRendererFactory } from '@jupyterlab/json-extension';
import { rendererFactory as javascriptRendererFactory } from '@jupyterlab/javascript-extension';
import { NotebookPanel, NotebookWidgetFactory, NotebookTracker, NotebookActions, INotebookModel, Notebook } from '@jupyterlab/notebook';
import { CodeMirrorEditorFactory, CodeMirrorMimeTypeService } from '@jupyterlab/codemirror';
import { IEditorServices } from '@jupyterlab/codeeditor';
import { Completer, CompleterModel, CompletionHandler, ConnectorProxy, KernelCompleterProvider } from '@jupyterlab/completer';
import { MathJaxTypesetter } from '@jupyterlab/mathjax2';
import * as nbformat from '@jupyterlab/nbformat';
import { newUuid } from './../../jupyter/utils/Ids';
import getMarked from './marked/marked';
import { requireLoader } from "@jupyter-widgets/html-manager";
import { WIDGET_MIMETYPE, WidgetRenderer } from "@jupyter-widgets/html-manager/lib/output_renderers";
import { Kernel } from "./../../jupyter/services/kernel/Kernel";
import CustomNotebookModelFactory from './model/CustomNotebookModelFactory';
import { INotebookProps } from './Notebook';
import { NotebookCommands } from './NotebookCommands';
import CellSidebarContentFactory from './cell/sidebar/base/CellSidebarContentFactory';
import { IPyWidgetsClassicManager } from "./../../jupyter/ipywidgets/IPyWidgetsClassicManager";
import { activateWidgetExtension } from "./../../jupyter/ipywidgets/IPyWidgetsJupyterLabPlugin";
import { activatePlotlyWidgetExtension } from "./../../jupyter/ipywidgets/plotly/JupyterlabPlugin";

export class NotebookAdapter {
  private _boxPanel: BoxPanel;
  private _notebookPanel?: NotebookPanel;
  private _uid: string;
  private _serviceManager: ServiceManager;
  private _commandRegistry: CommandRegistry;
  private _props: INotebookProps;
  private _model: nbformat.INotebookContent;
  private _tracker?: NotebookTracker;
  private _kernel?: Kernel;
  private _store?: Store;
  private _ipywidgets?: 'lab' | 'classic';
  private _iPyWidgetsClassicManager?: IPyWidgetsClassicManager;
  private _CellSidebar?: (props: any) => JSX.Element;
  private _nbgrader: boolean;
  private _readOnly: boolean;
  private _context?: Context<INotebookModel>;

  constructor(props: INotebookProps, store: any, serviceManager: ServiceManager) {
    this._props = props;
    this._store = store;
    this._serviceManager = serviceManager;
    this._model = props.model;
    this._CellSidebar = props.CellSidebar;
    this._nbgrader = props.nbgrader;
    this._readOnly = props.readOnly;
    this._ipywidgets = props.ipywidgets;
    this._kernel = props.kernel;
    this._boxPanel = new BoxPanel();
    this._boxPanel.addClass('dla-Jupyter-Notebook');
    this._boxPanel.spacing = 0;
    this._uid = props.uid;
    this._commandRegistry = new CommandRegistry();
    this.loadNotebook = this.loadNotebook.bind(this);
  }

  loadNotebook(): void {
    const useCapture = true;
    document.addEventListener(
      'keydown',
      event => { this._commandRegistry?.processKeydownEvent(event); },
      useCapture,
    );
    const rendererFactories = standardRendererFactories.filter(factory => factory.mimeTypes[0] !== 'text/javascript');
    rendererFactories.push(jsonRendererFactory);
    rendererFactories.push(javascriptRendererFactory);
    const rendermime = new RenderMimeRegistry({
      initialFactories: rendererFactories,
      latexTypesetter: new MathJaxTypesetter({
        url: PageConfig.getOption('mathjaxUrl'),
        config: PageConfig.getOption('mathjaxConfig'),
      }),
      markdownParser: getMarked(),
    }); 
    const documentRegistry = new DocumentRegistry({});
    const mimeTypeService = new CodeMirrorMimeTypeService();
    const editorServices: IEditorServices = {
      factoryService: new CodeMirrorEditorFactory(),
      mimeTypeService,
    };
    const editorFactory = editorServices.factoryService.newInlineEditor;
    const contentFactory = this._CellSidebar
    ?
      new CellSidebarContentFactory(
        this._CellSidebar,
        this._uid,
        this._nbgrader,
        this._commandRegistry,
        this._store,
        { editorFactory },
      )
    :
      new NotebookPanel.ContentFactory(
        { editorFactory }
      );
    this._tracker = new NotebookTracker({ namespace: this._uid });
    if (this._ipywidgets === 'classic') {
      this._iPyWidgetsClassicManager = new IPyWidgetsClassicManager({ loader: requireLoader });
      rendermime.addFactory(
        {
          safe: false,
          mimeTypes: [WIDGET_MIMETYPE],
          createRenderer: (options) => new WidgetRenderer(options, this._iPyWidgetsClassicManager!),
        },
        1
      );
    }
    else if (this._ipywidgets === 'lab') {
      const widgetRegistry = activateWidgetExtension(rendermime, this._tracker , null, null);
      activatePlotlyWidgetExtension(widgetRegistry);
    }
    const notebookWidgetFactory = new NotebookWidgetFactory({
      name: 'Notebook',
      modelName: 'notebook',
      fileTypes: ['notebook'],
      defaultFor: ['notebook'],
      preferKernel: true,
      canStartKernel: false,
      rendermime,
      contentFactory,
      mimeTypeService: editorServices.mimeTypeService,
    });
    /*
    notebookWidgetFactory.widgetCreated.connect((sender, widget) => {
      widget.context.pathChanged.connect(() => {
        void this._tracker?.save(widget);
      });
      void this._tracker?.add(widget);
    });
    */
    documentRegistry.addWidgetFactory(notebookWidgetFactory);
    const notebookModelFactory = new CustomNotebookModelFactory({});
    documentRegistry.addModelFactory(notebookModelFactory);
    this._context = new Context({
      manager: this._serviceManager,
      factory: notebookModelFactory,  
      path: this._props.path || "ping.ipynb",
      kernelPreference: {
//        id: this.kernel?.kernelId,
        shouldStart: false,
        autoStartDefault: false,
        shutdownOnDispose: false,
      }
    });
    this._notebookPanel = documentRegistry.getWidgetFactory('notebook')?.createNew(this._context) as NotebookPanel;
    const isNew = (this._props.path !== "") ? false : true;
    this._context.initialize(isNew).then(() => {
      if (this._kernel) {
        this._kernel.getJupyterKernel().then(kernelConnection => {
          this._context?.sessionContext.changeKernel(kernelConnection.model).then(() => {
            const completerHandler = this.setupCompleter(this._notebookPanel!);
            NotebookCommands(this._commandRegistry, this._notebookPanel!, completerHandler, this._props);  
          });
        });
      }
      this.populateNotebook(this._model);
    });
    if (this._ipywidgets === 'classic') {
      this._notebookPanel.sessionContext.kernelChanged.connect((sender: any, args: IChangedArgs<JupyterKernel.IKernelConnection | null, JupyterKernel.IKernelConnection | null, 'kernel'>) => {
        this._iPyWidgetsClassicManager?.registerWithKernel(args.newValue);
      });
    }
    BoxPanel.setStretch(this._notebookPanel, 0);
    this._boxPanel.addWidget(this._notebookPanel);
    window.addEventListener('resize', () => {
      this._notebookPanel?.update();
    });
    const tracker = this._tracker;
    function getCurrent(args: ReadonlyPartialJSONObject): NotebookPanel | null {
      const widget = tracker.currentWidget;
      return widget;
    }
    function isEnabled(): boolean {
      return (
        tracker.currentWidget !== null
      );
    }
    this._commandRegistry.addCommand('run-selected-codecell', {
      label: 'Run Cell',
      execute: args => {
        const current = getCurrent(args);
        if (current) {
          const { context, content } = current;
          NotebookActions.run(content, context.sessionContext);
        }
      },
      isEnabled,
    });
  }

  populateNotebook(model: nbformat.INotebookContent) {
    this._model = model;
    if (this._model) {
      this._notebookPanel?.model?.cells.clear();
      this._model.cells.map((cell, index) => {
        switch(cell.cell_type) {
          case "code": {
            const cellModel = new CodeCellModel({
              cell: {
                ...cell,
                metadata: {
                  ...cell.metadata,
                  editable: !this._readOnly,
                }
              },
              id: cell.id ? cell.id.toString() : newUuid(),
            });
            this._notebookPanel?.model?.cells.push(cellModel);
            break;
          }
          case "markdown": {
            const cellModel = new MarkdownCellModel({
              cell: {
                ...cell,
                metadata: {
                  ...cell.metadata,
                  editable: !this._readOnly,
                }
              },
              id: cell.id ? cell.id.toString() : newUuid(),
            });
            this._notebookPanel?.model?.cells.push(cellModel);
            break;
          }
          case "raw": {
            const cellModel = new RawCellModel({
              cell: {
                ...cell,
                metadata: {
                  ...cell.metadata,
                  editable: !this._readOnly,
                }
              },
              id: cell.id ? cell.id.toString() : newUuid(),
            });
            this._notebookPanel?.model?.cells.push(cellModel);
            break;
          }
        }
      });
    }
  }

  setupCompleter(notebookPanel: NotebookPanel) {
    const editor = notebookPanel.content.activeCell && notebookPanel.content.activeCell.editor;
    const sessionContext = notebookPanel.context.sessionContext;
    const completerModel = new CompleterModel();
    const completer = new Completer({ editor, model: completerModel });
    const completerTimeout = 1000;
    const provider = new KernelCompleterProvider();
    const connector = new ConnectorProxy(
      {
        widget: notebookPanel,
        editor,
        session: sessionContext.session
      },
      [provider],
      completerTimeout,
    );
    const handler = new CompletionHandler({ completer, connector });
    void sessionContext.ready.then(() => {
      const provider = new KernelCompleterProvider();
      const connector = new ConnectorProxy(
        { widget: this._notebookPanel!, editor, session: sessionContext.session },
        [provider],
        completerTimeout,
      );
      handler.connector = connector;
    });
    handler.editor = editor;
    notebookPanel.content.activeCellChanged.connect((sender: any, snippet: Cell<ICellModel>) => {
      handler.editor = snippet && snippet.editor;
    });
    completer.hide();
    Widget.attach(completer, document.body);
    return handler;
  }

  changeKernel(kernel: Kernel) {
    this._kernel = kernel;
    this._kernel.getJupyterKernel().then(kernelConnection => {
      this._context?.sessionContext.changeKernel(kernelConnection.model).then(() => {
        const completerHandler = this.setupCompleter(this._notebookPanel!);
        NotebookCommands(this._commandRegistry, this._notebookPanel!, completerHandler, this._props);  
      });
    });      
  }

  get uid(): string {
    return this._uid;
  }

  get notebookPanel(): NotebookPanel | undefined {
    return this._notebookPanel;
  }

  get commands(): CommandRegistry {
    return this._commandRegistry;
  }

  get panel(): BoxPanel {
    return this._boxPanel;
  }

  get serviceManager(): ServiceManager {
    return this._serviceManager;
  }

  setDefaultCellType = (cellType: nbformat.CellType) => {
    this._notebookPanel!.content!.notebookConfig!.defaultCell! = cellType;
  }

  changeCellType = (cellType: nbformat.CellType) => {
//    NotebookActions.changeCellType(this._notebookPanel?.content!, cellType);
    this.doChangeCellType(this._notebookPanel?.content!, cellType);
  }
    
  private doChangeCellType(
    notebook: Notebook,
    value: nbformat.CellType
  ): void {
    const model = notebook.model!;
    const cells = model.cells;
    cells.beginCompoundOperation();
    notebook.widgets.forEach((child, index) => {
      if (!notebook.isSelectedOrActive(child)) {
        return;
      }
      if (child.model.type !== value) {
        const cell = child.model.toJSON();
        let newCell: ICellModel;
        switch (value) {
          case 'code':
            newCell = model.contentFactory.createCodeCell({ cell });
            break;
          case 'markdown':
            newCell = model.contentFactory.createMarkdownCell({ cell });
            if (child.model.type === 'code') {
              newCell.trusted = false;
            }
            break;
          default:
            newCell = model.contentFactory.createRawCell({ cell });
            if (child.model.type === 'code') {
              newCell.trusted = false;
            }
        }
        cells.set(index, newCell);
      }
      if (value === 'markdown') {
        // Fetch the new widget and unrender it.
        child = notebook.widgets[index];
        (child as MarkdownCell).rendered = false;
      }
    });
    cells.endCompoundOperation();
    notebook.deselectAll();
  }

  dispose = () => {
    this._context?.dispose();
    this._notebookPanel?.dispose();
  }

}

export default NotebookAdapter;
