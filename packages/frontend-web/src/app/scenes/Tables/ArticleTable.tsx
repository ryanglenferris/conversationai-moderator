/*
Copyright 2019 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { autobind } from 'core-decorators';
import FocusTrap from 'focus-trap-react';
import { List, Set } from 'immutable';
import keyboardJS from 'keyboardjs';
import React from 'react';
import { InjectedRouter, Link, WithRouterProps } from 'react-router';

import { IArticleModel, ICategoryModel, IUserModel, ModelId } from '../../../models';
import * as icons from '../../components/Icons';
import { Scrim } from '../../components/Scrim';
import {
  updateArticle,
  updateArticleModerators,
  updateCategoryModerators,
} from '../../platform/dataService';
import {
  HEADER_HEIGHT,
  NICE_LIGHTEST_BLUE,
  NICE_MIDDLE_BLUE,
  SCRIM_STYLE,
} from '../../styles';
import { partial } from '../../util/partial';
import { css, stylesheet } from '../../utilx';
import { AssignModerators } from '../Root/components/AssignModerators';
import { articlesLink, categoriesLink, dashboardLink } from '../routes';
import { ArticleControlPopup } from './ArticleControlPopup';
import { ControlFlag, MagicTimestamp, ModeratorsWidget, SimpleTitleCell, TitleCell } from './components';
import { FilterSidebar } from './FilterSidebar';
import { ARTICLE_TABLE_STYLES, CELL_HEIGHT, COMMON_STYLES, ICON_STYLES } from './styles';
import { big, flexCenter, medium } from './styles';
import {
  NOT_SET,
  SORT_APPROVED,
  SORT_DEFERRED,
  SORT_FLAGGED,
  SORT_HIGHLIGHTED,
  SORT_LAST_MODERATED,
  SORT_NEW,
  SORT_REJECTED,
    SORT_TITLE,
  SORT_UPDATED,
} from './utils';
import {
  executeFilter,
  executeSort,
  filterString,
  IFilterItem,
  isFilterActive,
  parseFilter,
  parseSort,
  sortString,
  updateSort,
} from './utils';

const STYLES = stylesheet({
  scrimPopup: {
    background: 'rgba(0, 0, 0, 0.4)',
    ...flexCenter,
    alignContent: 'center',
  },

  pagingBar: {
    height: `${HEADER_HEIGHT}px`,
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    textSize: '18px',
    color: 'white',
  },
});

export interface IIArticleTableProps extends WithRouterProps {
  myUserId: string;
  categories: List<ICategoryModel>;
  articles: List<IArticleModel>;
  users: List<IUserModel>;
  routeParams: {[key: string]: string};
  router: InjectedRouter;
}

const POPUP_MODERATORS = 'moderators';
const POPUP_CONTROLS = 'controls';
const POPUP_FILTERS = 'filters';
const POPUP_SAVING = 'saving';

export interface IIArticleTableState {
  page_size: number;
  current_page: number;
  total_pages: number;
  filterString: string;
  filter: Array<IFilterItem>;
  sortString: string;
  sort: Array<string>;
  summary: IArticleModel;
  usersMap: Map<string, IUserModel>;
  visibleArticles: Array<IArticleModel>;

  popupToShow?: string;

  // Fields used by article control popup
  selectedArticle?: IArticleModel;

  // Fields used by set moderators popup
  targetIsCategory?: boolean;
  targetId?: ModelId;
  moderatorIds?: Set<ModelId>;
  superModeratorIds?: Set<ModelId>;
}

const clearPopupsState: Pick<IIArticleTableState,
  'popupToShow' | 'selectedArticle' | 'targetIsCategory' | 'targetId' | 'moderatorIds' | 'superModeratorIds'
  > = {
  popupToShow: null,
  selectedArticle: null,
  targetIsCategory: null,
  targetId: null,
  moderatorIds: null,
  superModeratorIds: null,
};

function getCategory(
  props: Readonly<IIArticleTableProps>) {
  let category: ICategoryModel | null = null;
  const m = /category=(\d+)/.exec(location.pathname);
  if (m) {
    for (const c of props.categories.toArray()) {
      if (c.id === m[1]) {
        category = c;
      }
    }
  }

  return category;
}

function processArticles(
  props: Readonly<IIArticleTableProps>,
  current_page: number,
  filter: Array<IFilterItem>,
  sort: Array<string>) {
  let processedArticles: Array<IArticleModel> = props.articles.toArray();

  if (Object.keys(filter).length > 0) {
    processedArticles = processedArticles.filter(executeFilter(filter, {myId: props.myUserId}));
  }
  if (sort.length > 0) {
    processedArticles = processedArticles.sort(executeSort(sort));
  }
  else {
    processedArticles = processedArticles.sort(executeSort(['+sourceCreatedAt']));
  }

  const usersMap = new Map<string, IUserModel>();
  props.users.map((u) => usersMap.set(u.id, u));

  let count = 0;
  const columns = [
    'unmoderatedCount',
    'approvedCount',
    'rejectedCount',
    'deferredCount',
    'highlightedCount',
    'flaggedCount',
  ];
  const summary: any =  {};
  for (const i of columns) {
    summary[i] = 0;
  }

  for (const a of processedArticles) {
    count += 1;
    for (const i of columns) {
      summary[i] += (a as any)[i];
    }
  }

  summary['id'] = 'summary';

  const category = getCategory(props);
  summary['category'] = category;

  summary['title'] = ` ${count} Title` + (count !== 1 ? 's' : '');

  if (category) {
    summary['title'] += ` in section ${category.label}`;
  }

  if (filter.length > 1 || (filter.length === 1 && filter[0].key !== 'category')) {
    summary['title'] += ' matching filter';
  }

  const page_size = Math.floor(window.innerHeight / CELL_HEIGHT) - 3;
  const pages = Math.ceil(processedArticles.length / page_size);
  if (pages > 1) {
    const start = current_page * page_size;
    const end = Math.min(start + page_size, processedArticles.length);
    processedArticles = processedArticles.slice(start, end);
  }

  return {
    usersMap,
    visibleArticles: [...processedArticles],
    summary,
    page_size,
    total_pages: pages,
    current_page: current_page,
  };
}

function updateArticles(state: IIArticleTableState, props: IIArticleTableProps) {
  const newVisible = [...state.visibleArticles];
  const newSummary = {...state.summary};

  const indexMap: { [key: string]: number; } = {};
  newVisible.map((a, i) => { indexMap[a.id] = i; });

  for (const a of props.articles.toArray()) {
    if (a.id in indexMap) {
      newVisible[indexMap[a.id]] = a;
    }
  }

  newSummary['category'] = getCategory(props);

  return {
    visibleArticles: newVisible,
    summary: newSummary,
  };
}

export class ArticleTable extends React.Component<IIArticleTableProps, IIArticleTableState> {
  constructor(props: Readonly<IIArticleTableProps>) {
    super(props);
    const filter: Array<IFilterItem> = props.routeParams ? parseFilter(props.routeParams.filter) : [];
    const sort: Array<string> = props.routeParams ? parseSort(props.routeParams.sort) : [];

    this.state = {
      filterString: props.routeParams ? props.routeParams.filter : NOT_SET,
      sortString: props.routeParams ? props.routeParams.sort : NOT_SET,
      filter,
      sort,
      ...processArticles(props, 0, filter, sort),
    };
  }

  componentWillReceiveProps(props: Readonly<IIArticleTableProps>): void {
    let filter: Array<IFilterItem> = this.state.filter;
    let sort: Array<string> = this.state.sort;
    let redoArticles = false;
    let filterUpdated = false;
    let sortUpdated = false;

    const newState: any = {};

    if (props.routeParams) {
      if (this.state.filterString !== props.routeParams.filter) {
        filterUpdated = true;
      }
      if (this.state.sortString !== props.routeParams.sort) {
        sortUpdated = true;
      }
    }
    else {
      if (this.state.filterString !== NOT_SET) {
        filterUpdated = true;
      }
      if (this.state.sortString !== NOT_SET) {
        sortUpdated = true;
      }
    }

    if (filterUpdated) {
      filter = props.routeParams ? parseFilter(props.routeParams.filter) : [];
      newState['filterString'] = props.routeParams ? props.routeParams.filter : NOT_SET;
      newState['filter'] = filter;
      redoArticles = true;
    }

    if (sortUpdated) {
      sort = props.routeParams ? parseSort(props.routeParams.sort) : [];
      newState['sortString'] = props.routeParams ? props.routeParams.sort : NOT_SET;
      newState['sort'] = sort;
      redoArticles = true;
    }

    if (redoArticles) {
      Object.assign(newState, processArticles(props, this.state.current_page, filter, sort));
    }
    else {
      Object.assign(newState, updateArticles(this.state, props));
    }

    this.setState(newState);
  }

  @autobind
  openSetModerators(targetId: ModelId, moderatorIds: Array<ModelId>, superModeratorIds: Array<ModelId>, isCategory: boolean) {
    this.setState({
      ...clearPopupsState,
      popupToShow: POPUP_MODERATORS,
      targetIsCategory: isCategory,
      targetId: targetId,
      moderatorIds: Set<ModelId>(moderatorIds),
      superModeratorIds: Set<ModelId>(superModeratorIds),
    });
  }

  @autobind
  openFilters() {
    this.setState({
      ...clearPopupsState,
      popupToShow: POPUP_FILTERS,
    });
  }

  @autobind
  openControls(article: IArticleModel) {
    this.setState({
      ...clearPopupsState,
      popupToShow: POPUP_CONTROLS,
      selectedArticle: article,
    });
  }

  @autobind
  clearPopups() {
    this.setState(clearPopupsState);
  }

  componentWillMount() {
    keyboardJS.bind('escape', this.clearPopups);
  }

  componentWillUnmount() {
    keyboardJS.unbind('escape', this.clearPopups);
  }

  renderFilterPopup(currentSort: string) {
    if (this.state.popupToShow !== POPUP_FILTERS) {
      return null;
    }

    const router = this.props.router;
    function setFilter(newFilter: Array<IFilterItem>) {
      router.push(dashboardLink(filterString(newFilter), currentSort));
    }

    return (
      <FilterSidebar
        filterString={this.state.filterString}
        filter={this.state.filter}
        myUserId={this.props.myUserId}
        users={this.props.users}
        setFilter={setFilter}
        clearPopup={this.clearPopups}
      />
    );
  }

  @autobind
  saveControls(isCommentingEnabled: boolean, isAutoModerated: boolean) {
    const articleId = this.state.selectedArticle.id;
    this.setState({
      ...clearPopupsState,
      popupToShow: POPUP_SAVING,
    });

    updateArticle(articleId, isCommentingEnabled, isAutoModerated)
      .then(this.clearPopups);
  }

  renderControlPopup(article: IArticleModel) {
    const imOpen = this.state.selectedArticle && this.state.selectedArticle.id === article.id;
    if (this.state.popupToShow !== POPUP_CONTROLS || !imOpen) {
      return null;
    }

    return (
      <ArticleControlPopup
        article={this.state.selectedArticle}
        saveControls={this.saveControls}
        clearPopups={this.clearPopups}
      />
    );
  }

  renderFlags(article: IArticleModel) {
    const that = this;
    const imOpen = that.state.selectedArticle && that.state.selectedArticle.id === article.id;

    function openDlg() {
      if (imOpen) {
        that.clearPopups();
      }
      else {
        that.openControls(article);
      }
    }

    return (
      <div {...css(imOpen ? ICON_STYLES.iconBackgroundCircle : big)}>
        {this.renderControlPopup(article)}
        <div onClick={openDlg} {...css(ICON_STYLES.iconCenter)}>
          <ControlFlag isCommentingEnabled={article.isCommentingEnabled} isAutoModerated={article.isAutoModerated}/>
        </div>
      </div>
    );
  }

  @autobind
  renderModerators(targetId: ModelId, moderatorIds: Array<ModelId>, superModeratorIds: Array<ModelId>, isCategory: boolean) {
    return (
      <ModeratorsWidget
        users={this.state.usersMap}
        moderatorIds={moderatorIds}
        superModeratorIds={superModeratorIds}
        openSetModerators={partial(this.openSetModerators, targetId, moderatorIds, superModeratorIds, isCategory)}
      />
    );
  }

  @autobind
  onAddModerator(userId: string) {
    this.setState({moderatorIds: this.state.moderatorIds.add(userId)});
  }

  @autobind
  onRemoveModerator(userId: string) {
    this.setState({moderatorIds: this.state.moderatorIds.remove(userId)});
  }

  @autobind
  saveModerators() {
    const moderatorIds = this.state.moderatorIds.toArray();
    const targetIsCategory = this.state.targetIsCategory;
    const targetId = this.state.targetId;
    this.setState({
      ...clearPopupsState,
      popupToShow: POPUP_SAVING,
    });

    if (targetIsCategory) {
      updateCategoryModerators(targetId, moderatorIds).then(this.clearPopups);
    }
    else {
      updateArticleModerators(targetId, moderatorIds).then(this.clearPopups);
    }
  }

  renderSetModerators() {
    if (this.state.popupToShow === POPUP_SAVING) {
      return (
        <Scrim isVisible onBackgroundClick={this.clearPopups} scrimStyles={STYLES.scrimPopup}>
          <div tabIndex={0} {...css(SCRIM_STYLE.popup)}>
            Saving....
          </div>
        </Scrim>
      );
    }

    if (this.state.popupToShow !== POPUP_MODERATORS) {
      return null;
    }

    return (
      <Scrim isVisible onBackgroundClick={this.clearPopups} scrimStyles={STYLES.scrimPopup}>
        <FocusTrap focusTrapOptions={{clickOutsideDeactivates: true}}>
          <div tabIndex={0} {...css(SCRIM_STYLE.popup, {position: 'relative'})}>
            <AssignModerators
              label={this.state.targetIsCategory ? 'Assign a category moderator' : 'Assign a moderator'}
              moderatorIds={this.state.moderatorIds}
              superModeratorIds={this.state.superModeratorIds}
              onAddModerator={this.onAddModerator}
              onRemoveModerator={this.onRemoveModerator}
              onClickDone={this.saveModerators}
              onClickClose={this.clearPopups}
            />
          </div>
        </FocusTrap>
      </Scrim>
    );
  }

  static renderTime(time: string | null) {
    if (!time) {
      return 'Never';
    }
    return <MagicTimestamp timestamp={time} inFuture={false}/>;
  }

  renderRow(article: IArticleModel, isSummary: boolean) {
    const lastModerated: any = (!isSummary) ? ArticleTable.renderTime(article.lastModeratedAt) : '';

    function getLink(tag: string) {
      if (isSummary) {
        if (article.category) {
          return categoriesLink(article.category.id, tag);
        }
        return categoriesLink('all', tag);
      }
      return articlesLink(article.id, tag);
    }

    let targetId: ModelId | null = null;
    let moderatorIds: Array<ModelId> | null = null;
    let superModeratorIds: Array<ModelId> | null = null;
    if (isSummary) {
      if (article.category) {
        targetId = article.category.id;
        moderatorIds = article.category.assignedModerators;
      }
    }
    else {
      targetId = article.id;
      moderatorIds = article.assignedModerators;
      if (article.category) {
        superModeratorIds = article.category.assignedModerators;
      }
    }

    const cellStyle = isSummary ? ARTICLE_TABLE_STYLES.summaryCell : ARTICLE_TABLE_STYLES.dataCell;

    return (
      <tr key={article.id} {...css(cellStyle, ARTICLE_TABLE_STYLES.dataBody)}>
        <td {...css(cellStyle)}>
          {isSummary ?
            <SimpleTitleCell article={article} link={getLink('new')}/>
            :
            <TitleCell article={article} link={getLink('new')}/>
          }
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('new')} {...css(COMMON_STYLES.cellLink)}>
            {article.unmoderatedCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('approved')} {...css(COMMON_STYLES.cellLink)}>
            {article.approvedCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('rejected')} {...css(COMMON_STYLES.cellLink)}>
            {article.rejectedCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('deferred')} {...css(COMMON_STYLES.cellLink)}>
            {article.deferredCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('highlighted')} {...css(COMMON_STYLES.cellLink)}>
            {article.highlightedCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.numberCell)}>
          <Link to={getLink('flagged')} {...css(COMMON_STYLES.cellLink)}>
            {article.flaggedCount}
          </Link>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.timeCell)}>
          {!isSummary && <MagicTimestamp timestamp={article.updatedAt} inFuture={false}/>}
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.timeCell)}>
          {lastModerated}
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.iconCell)}>
          <div {...css({display: 'inline-block'})}>
            {!isSummary && this.renderFlags(article)}
          </div>
        </td>
        <td {...css(cellStyle, ARTICLE_TABLE_STYLES.iconCell)}>
          {targetId && this.renderModerators(targetId, moderatorIds, superModeratorIds, isSummary)}
        </td>
      </tr>
    );
  }

  @autobind
  nextPage() {
    this.setState({...processArticles(this.props, this.state.current_page + 1, this.state.filter, this.state.sort)});
  }

  @autobind
  previousPage() {
    this.setState({...processArticles(this.props, this.state.current_page - 1, this.state.filter, this.state.sort)});
  }

  renderPaging() {
    if (this.state.total_pages < 2) {
      return null;
    }

    const canNext = this.state.current_page !== this.state.total_pages - 1;
    const canPrevious = this.state.current_page !== 0;

    return (
      <div key="paging" {...css(STYLES.pagingBar)}>
        <div {...css({width: '60%', height: `${HEADER_HEIGHT}px`, lineHeight: `${HEADER_HEIGHT}px`, textAlign: 'center', position: 'relative'})}>
          {canPrevious && <span key="previous" onClick={this.previousPage} {...css({position: 'absolute', left: 0})}><icons.ArrowIcon/></span>}
          Page {this.state.current_page + 1} of {this.state.total_pages}&nbsp;
          {canNext && <span key="next" onClick={this.nextPage} {...css({position: 'absolute', right: 0})}><icons.ArrowFIcon/></span>}
        </div>
      </div>
    );
  }

  render() {
    const {
      filter,
      sort,
      summary,
      visibleArticles,
    } = this.state;

    const currentFilter = filterString(filter);
    const currentSort = sortString(sort);

    function renderDirectionIndicatorUp() {
      return (
        <div {...css({position: 'absolute', left: 0, right: 0, top: '-18px', textAlign: 'center'})}>
          <icons.KeyUpIcon/>
        </div>
      );
    }

    function renderDirectionIndicatorDown() {
      return (
        <div {...css({position: 'absolute', left: 0, right: 0, bottom: '-18px', textAlign: 'center'})}>
          <icons.KeyDownIcon/>
        </div>
      );
    }

    function renderHeaderItem(label: string | JSX.Element, sortField: string) {
      let directionIndicator: string | JSX.Element = '';
      let nextSortItem = `+${sortField}`;

      for (const item of sort) {
        if (item.endsWith(sortField)) {
          if (item[0] === '+') {
            directionIndicator = renderDirectionIndicatorDown();
            nextSortItem =  `-${sortField}`;
          }
          else if (item[0] === '-') {
            directionIndicator = renderDirectionIndicatorUp();
            nextSortItem = sortField;
          }
          break;
        }
      }
      const newSort = sortString(updateSort(sort, nextSortItem));
      return (
        <Link to={dashboardLink(currentFilter, newSort)} {...css(COMMON_STYLES.cellLink)}>
          <span {...css({position: 'relative'})}>
            {label}
            {directionIndicator}
          </span>
        </Link>
      );
    }

    const filterActive = isFilterActive(this.state.filter);
    return (
      <div key="main">
        <table key="data" {...css(ARTICLE_TABLE_STYLES.dataTable, {position: 'relative'})}>
          <thead {...css(ARTICLE_TABLE_STYLES.dataHeader)}>
            <tr>
              <th key="title" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.textCell)}>
                {renderHeaderItem('Title', SORT_TITLE)}
                {/*<div {...css({float: 'right'})}>*/}
                  {/*{renderHeaderItem(<icons.ClockIcon/>, SORT_SOURCE_CREATED)}*/}
                {/*</div>*/}
              </th>
              <th key="new" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('New', SORT_NEW)}
              </th>
              <th key="approved" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('Approved', SORT_APPROVED)}
              </th>
              <th key="rejected" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('Rejected', SORT_REJECTED)}
              </th>
              <th key="deferred" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('Deferred', SORT_DEFERRED)}
              </th>
              <th key="highlighted" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('Highlighted', SORT_HIGHLIGHTED)}
              </th>
              <th key="flagged" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.numberCell)}>
                {renderHeaderItem('Flagged', SORT_FLAGGED)}
              </th>
              <th key="modified" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.timeCell)}>
                {renderHeaderItem('Modified', SORT_UPDATED)}
              </th>
              <th key="moderated" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.timeCell)}>
                {renderHeaderItem('Moderated', SORT_LAST_MODERATED)}
              </th>
              <th key="flags" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.iconCell)}/>
              <th key="mods" {...css(ARTICLE_TABLE_STYLES.headerCell, ARTICLE_TABLE_STYLES.iconCell, {...flexCenter, color: filterActive ? NICE_MIDDLE_BLUE : NICE_LIGHTEST_BLUE})}>
                <div {...css({width: '44px', height: '44px', borderRadius: '50%', ...flexCenter, backgroundColor: filterActive ? NICE_LIGHTEST_BLUE : NICE_MIDDLE_BLUE})}>
                  <icons.FilterIcon {...css(medium)} onClick={this.openFilters}/>
                </div>
                {this.renderFilterPopup(currentSort)}
              </th>
            </tr>
          </thead>
          <tbody>
            {this.renderRow(summary, true)}
            {visibleArticles.map((article: IArticleModel) => this.renderRow(article, false))}
          </tbody>
        </table>
        {this.renderPaging()}
        {this.renderSetModerators()}
      </div>
    );
  }
}