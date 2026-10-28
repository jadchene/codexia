export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
