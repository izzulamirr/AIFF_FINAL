// isFieldWeld/isWeldCategory moved to @easy/shared so the web app can use the
// same test -- the container page needs a spool's field-weld count to add the
// 150mm allowance, and two copies of "what counts as a field weld" is exactly
// the sort of split that let Type and Category be confused in the first place.
export { isFieldWeld, isWeldCategory } from "@easy/shared";
